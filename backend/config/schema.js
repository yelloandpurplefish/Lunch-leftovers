/**
 * 資料模型與規則的單一事實來源。
 *
 * 集合命名沿用原有風格（snake_case），新增的集合列在下半部。
 * **所有「一天只能一次」的紀錄都用決定性的 doc id**（見下方 ids），
 * 這樣重複送出會自然覆蓋/擋掉，不必靠查詢競爭判斷，也省掉一次 query。
 */

// ── 集合 ────────────────────────────────────────────────────────────
const COL = {
  // 原有
  users: 'users',
  taskRecords: 'task_records',
  lotteryRecords: 'lottery_records',
  exchangeRecords: 'exchange_records',
  rewardItems: 'reward_items',
  systemConfig: 'system_config',
  dailyMenu: 'daily_menu',
  parentSignIns: 'parent_sign_ins',

  // 新增：名冊與菜色
  classes: 'classes',            // 班級名冊（年級/班名/人數/午餐長/導師/班級幣池）
  dishes: 'dishes',              // 菜色資料庫（每份份量、單價、碳排係數）
  /**
   * 帳號保留表：doc id = 小寫後的帳號或 email，內容 { userId }。
   * Firestore 沒有唯一鍵，靠這張表在 transaction 內搶占，才能真正避免同名帳號。
   */
  accountIndex: 'account_index',

  /** 物聯網裝置（ESP32 稱重模組）註冊表：一台一筆，doc id = deviceId。*/
  devices: 'devices',
  /**
   * 裝置上傳的原始讀數。doc id = `裝置_讀數序號`，裝置補傳同一筆會覆蓋而不是重複，
   * 這是離線補傳能安全重試的關鍵。
   */
  deviceReadings: 'device_readings',

  // 新增：紀錄管線（取代原本的 leftover_analysis）
  mealSessions: 'meal_sessions', // 一班一天一場四桶量測
  dishLeftovers: 'dish_leftovers', // 每班每天每道菜的剩餘量（支援跨班查詢）
  mealChecks: 'meal_checks',     // 教師逐生勾選「吃完一餐」
  coinTx: 'coin_transactions',   // 幣別總帳（個人與班級）
};

/** 已移除的集合：改用 dish_leftovers + meal_sessions（見 README「紀錄流程」）。*/
const REMOVED_COL = ['leftover_analysis'];

// ── 角色 ────────────────────────────────────────────────────────────
const ROLES = {
  STUDENT: 'student',           // 觀看、兌換、抽獎
  LUNCH_LEADER: 'lunch_leader', // 午餐長：負責紀錄（四桶辨識），不可兌換/抽獎
  PARENT: 'parent',             // 簽到、查看孩子午餐狀況（無幣系統）
  TEACHER: 'teacher',           // 每日逐生勾選是否吃完
  /**
   * 技術員：只管硬體，不碰學生資料與幣。
   * 能做的事：註冊/綁定稱重模組、設定盆體扣重與校正、看裝置健康狀態。
   */
  TECHNICIAN: 'technician',
  ADMIN: 'admin',
};

const ALL_ROLES = Object.values(ROLES);

/** 可自行註冊的角色（教師/管理員由管理者建立或 seed 產生）。*/
const SELF_REGISTER_ROLES = [ROLES.STUDENT, ROLES.PARENT];

/** 擁有幣餘額的角色（家長沒有幣系統）。*/
const COIN_HOLDER_ROLES = [ROLES.STUDENT, ROLES.LUNCH_LEADER];

/** 可以消耗幣（兌換/抽獎）的角色 —— 午餐長只累積不消耗。*/
const COIN_SPENDER_ROLES = [ROLES.STUDENT];

/** 可以做紀錄（四桶辨識）的角色。*/
const RECORDER_ROLES = [ROLES.LUNCH_LEADER, ROLES.TEACHER, ROLES.ADMIN];

// ── 發幣規則（使用者指定，勿擅自加項）──────────────────────────────
const COIN_RULES = {
  /** 教師勾選「吃完他的部分」→ 個人 +1 E、+1 S（每人每日一次）*/
  MEAL_FINISHED: { E: 1, S: 1 },
  /** 家長簽到 → **綁定的學生** +1 S（每位家長每日一次）*/
  PARENT_SIGN_IN: { E: 0, S: 1 },
  /**
   * @deprecated 紀錄結算的 E/S 已改為營養攝取與減碳樹數公式（見 TUNABLE_DEFAULTS）。
   * 這兩個舊常數保留僅為讀取舊資料時的相容，新的結算不再使用。
   */
  k_E: 100,
  FULL_SESSION_CLASS_S: 1,
  /** 基準線移動平均餐數 */
  baselineWindow: 10,
  /** 無歷史時的起步基準：供應量 × 此比例 */
  fallbackBaselineRatio: 0.35,
};


// ── 發幣公式的可調參數 ────────────────────────────────────────────────
/**
 * **這裡是預設值，不是實際採用值。**
 *
 * 實際採用值存在 Firestore 的 `system_config/coin_rules`，由開發者面板調整，
 * 讀取時與這份預設值深度合併（見 lib/settings.js）。這樣做的理由：
 * 營養係數與碳排常數會隨著實測、教材版本、學校政策而變，
 * 每次都要改程式重新部署並不合理。
 *
 * 兩種幣的語意：
 *   E = Energy —— 學生實際**吃下去**的營養（蛋白質 + 膳食纖維）
 *   S = SDGs   —— 比全校歷史平均**少浪費**的部分，換算成碳排，再換算成樹
 *
 * 兩者都以**人均**計算，再依 CLASS_COIN_TO_MEMBER 全額加給班上每位學生。
 * 班級人數不同（28/30/26），不人均的話人多的班天生佔優。
 */
const TUNABLE_DEFAULTS = {
  /** E 幣：攝取營養 → 幣 */
  energy: {
    /** 每公克蛋白質換算的 E 幣 */
    kProtein: 0.05,
    /** 每公克膳食纖維換算的 E 幣（纖維攝取量遠低於蛋白質，係數相應提高） */
    kFiber: 0.5,
  },

  /**
   * 每公斤食物的營養含量（公克/公斤）。
   * 依菜色分類給預設值；個別菜品可在 dishes 上以 proteinPerKg / fiberPerKg 覆寫。
   * 使用者特別提到的「每公斤蔬菜的膳食纖維」就是 蔬菜.fiberPerKg。
   */
  nutrition: {
    byCategory: {
      主食: { proteinPerKg: 26, fiberPerKg: 4 },
      主菜: { proteinPerKg: 200, fiberPerKg: 0 },
      副菜: { proteinPerKg: 120, fiberPerKg: 5 },
      蔬菜: { proteinPerKg: 15, fiberPerKg: 20 },
      湯品: { proteinPerKg: 10, fiberPerKg: 3 },
    },
    /** 分類不在上表時的保底值 */
    fallback: { proteinPerKg: 30, fiberPerKg: 5 },
  },

  /** S 幣：少浪費 → 碳排 → 樹 → 幣 */
  sdg: {
    /** 每公斤廚餘的碳排放（kgCO2e/kg）*/
    co2PerKgWaste: 2.06,
    /** 一棵樹每年吸收的二氧化碳（kg）*/
    treeAnnualCo2Kg: 21.8,
    /**
     * 樹 → S 幣的放大常數。
     * 人均每餐約省下 0.003 棵樹，直接當幣會全部進位成 0，
     * 因此樹數負責「展示」、S 幣另外乘上這個常數負責「可用」。
     */
    sCoinPerTree: 1000,
    /** 全校歷史平均取最近幾場已結算的紀錄 */
    schoolBaselineWindow: 30,
    /** 全校還沒有足夠歷史時的起步基準（每人每餐廚餘公克）*/
    fallbackSchoolWastePerCapitaG: 120,
    /** 少於這麼多場歷史就用上面的起步基準，避免頭幾天被極端值主導 */
    minSchoolSamples: 3,
  },
};

/** 可調參數存放的位置：system_config 集合下的這份文件。*/
const TUNABLE_DOC_ID = 'coin_rules';

/**
 * 班級幣如何進個人：'full' = 班級增長全額加給每位學生（使用者選定）。
 * 班級池本身仍獨立記帳，供班際排行與展示。
 */
const CLASS_COIN_TO_MEMBER = 'full';

// ── 跨班支援：門檻 ──────────────────────────────────────────────────
const SUPPORT = {
  /**
   * 本班某道菜「剩餘量不足」的判定：剩餘克數 ÷ 當餐供應克數 < 此比例。
   * 只有在本班此菜品低於門檻時，才顯示其他班是否還有這道菜（使用者指定行為）。
   */
  shortageRatio: 0.15,
  /** 其他班要被視為「還有這道菜」的最低剩餘克數，避免顯示幾乎見底的班級。*/
  minOfferGrams: 300,
};

// ── 稱重模組（IoT）────────────────────────────────────────────────
/**
 * 稱重模組（ESP32 + HX711 load cell）相關設定。
 *
 * 量測鏈：原始 ADC → 扣零點 → 除以校正係數 → 毛重(g) → 扣盆重 → 淨剩食(g)
 *   netG = (raw - zeroOffset) / calibrationFactor - tareG
 *
 * 之所以把 tare/校正放伺服器而不是燒進韌體：盆子會換、感測器會漂移，
 * 現場換一個盆不該要重新燒韌體；裝置只上傳原始值，換算與修正都在伺服器。
 */
const DEVICE = {
  /** 裝置 token 長度（隨機字元數）。*/
  tokenLength: 40,
  /** 超過這個秒數沒有心跳就視為離線。*/
  offlineAfterSeconds: 900,
  /** 允許補傳的天數（離線佇列回灌用），太舊的資料拒收以免污染統計。*/
  backfillDays: 3,
  /** 單次讀數的合理範圍（公克），超出視為異常需人工確認。*/
  minNetGrams: -200,
  maxNetGrams: 60000,
  /** 淨重在此範圍內視為 0（磅秤雜訊）。*/
  zeroBandGrams: 30,
  /** 裝置設定變更時 configVersion +1，裝置據此決定要不要重新抓設定。*/
  configVersionField: 'configVersion',
};

// ── 四桶配置（與影像辨識服務的桶別一致）────────────────────────────
const BUCKET_LAYOUT = [
  { id: 'staple', label: '主食桶', dishSlots: ['staple'] },
  { id: 'sideA', label: '配菜桶 A', dishSlots: ['main', 'side1'] },
  { id: 'sideB', label: '配菜桶 B', dishSlots: ['side2', 'veg'] },
  { id: 'soup', label: '湯桶', dishSlots: ['soup'] },
];

const MENU_SLOTS = ['staple', 'main', 'side1', 'side2', 'veg', 'soup'];

const SLOT_LABEL = {
  staple: '主食', main: '主菜', side1: '副菜一', side2: '副菜二', veg: '蔬菜', soup: '湯品',
};

const SLOT_CATEGORY = {
  staple: '主食', main: '主菜', side1: '副菜', side2: '副菜', veg: '蔬菜', soup: '湯品',
};

// ── 決定性 doc id（天然防重複）──────────────────────────────────────
const ids = {
  /** 一位學生一天只有一筆「吃完一餐」勾選 */
  mealCheck: (date, studentId) => `${date}_${studentId}`,
  /** 一位家長一天只能簽到一次 */
  parentSignIn: (date, parentId) => `${date}_${parentId}`,
  /** 一班一天一場量測 */
  mealSession: (classId, date) => `${classId}_${date}`,
  /** 一班一天一道菜（以菜單欄位為鍵，同一餐不會重複）*/
  dishLeftover: (classId, date, slot) => `${classId}_${date}_${slot}`,
  /**
   * 一台裝置的一筆讀數。裝置離線補傳時會用同一個 readingId 重試，
   * 決定性 id 讓重試自然覆蓋，不會變成兩筆。
   */
  deviceReading: (deviceId, readingId) => `${deviceId}_${readingId}`,
};

module.exports = {
  TUNABLE_DEFAULTS,
  TUNABLE_DOC_ID,
  COL,
  DEVICE,
  REMOVED_COL,
  ROLES,
  ALL_ROLES,
  SELF_REGISTER_ROLES,
  COIN_HOLDER_ROLES,
  COIN_SPENDER_ROLES,
  RECORDER_ROLES,
  COIN_RULES,
  CLASS_COIN_TO_MEMBER,
  SUPPORT,
  BUCKET_LAYOUT,
  MENU_SLOTS,
  SLOT_LABEL,
  SLOT_CATEGORY,
  ids,
};
