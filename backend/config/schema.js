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

  // 名冊與菜色
  /** 班級名冊（年級/班名/人數/導師/午餐長）。午餐長＝lunchLeaderUserId 指向的那位學生。 */
  classes: 'classes',
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

  // 紀錄
  mealSessions: 'meal_sessions', // 一班一天一場：午餐長依序稱重的全班剩食量
  dishLeftovers: 'dish_leftovers', // 每班每天每道菜的剩餘量（支援跨班查詢）
  mealChecks: 'meal_checks',     // 教師逐生勾選「吃完一餐」
  /** 學生拍自己餐盤的辨識結果：一人一天一筆（照片不存）。 */
  plateScans: 'plate_scans',
  coinTx: 'coin_transactions',   // ESG 幣總帳
};

// ── 角色 ────────────────────────────────────────────────────────────
/**
 * 帳號的角色。**午餐長不是角色**：它是附加在某位學生身上的身分，
 * 由 classes/{classId}.lunchLeaderUserId 指定（見 middleware/auth.js 的 isLunchLeader）。
 * 午餐長仍是學生，學生能做的事他都能做，另外多了本班稱重紀錄的權限。
 */
const ROLES = {
  STUDENT: 'student',           // 觀看、兌換、抽獎、拍餐盤（午餐長另加稱重紀錄）
  PARENT: 'parent',             // 簽到、查看孩子午餐狀況（無幣系統）
  TEACHER: 'teacher',           // 每日逐生勾選是否吃完；也能做本班稱重紀錄
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

/** 擁有 ESG 幣（累積與消耗）的角色。家長、教師都沒有幣系統。*/
const COIN_HOLDER_ROLES = [ROLES.STUDENT];

// ── ESG 幣 ──────────────────────────────────────────────────────────
/**
 * 只有一種幣：ESG 幣。餘額只有 users.esgCoin 一個欄位。
 *
 * 總帳每一筆記 coin:'ESG'，獲得類再用 source 標出來源：
 *   E 營養、S 減碳、G 感謝
 * 呼叫端傳 { E, S, G }，意思是「從各來源各得多少 ESG」，
 * 餘額是一個數字，而「ESG 從哪裡來」仍查得到。
 *
 * 目前的發幣只有下面兩項（使用者指定，勿擅自加項）。
 * 稱重紀錄是單純的全班剩食紀錄，不發幣；拍餐盤的發幣下一輪定義。
 */
const ESG = 'ESG';

const COIN_RULES = {
  /**
   * 教師勾選「吃完他的部分」→ 個人得 ESG：營養 1、減碳 1、感謝見下。
   * 感謝（G 來源）的額度不在這裡，而在 TUNABLE_DEFAULTS.gratitude.mealFinishedG，
   * 因為那是學校會想調的政策數字，不該要改程式重新部署。
   */
  MEAL_FINISHED: { E: 1, S: 1 },
  /** 家長簽到 → **綁定的學生** +1（減碳來源；每位家長每日一次）*/
  PARENT_SIGN_IN: { E: 0, S: 1 },
};


// ── 可調參數 ─────────────────────────────────────────────────────────
/**
 * **這裡是預設值，不是實際採用值。**
 *
 * 實際採用值存在 Firestore 的 `system_config/coin_rules`，由管理員面板調整，
 * 讀取時與這份預設值深度合併（見 lib/settings.js）。
 */
const TUNABLE_DEFAULTS = {
  /**
   * 感謝 —— 教師確認「吃完他的部分」時發給該學生的 ESG。
   * 它不是算出來的，而是「老師看見你吃完了」這件事的份量，屬於學校政策。
   */
  gratitude: {
    /** 教師確認完食 → 該學生 +G（每人每日一次，取消勾選會沖銷）*/
    mealFinishedG: 5,
  },

  /**
   * 建議攝取熱量（**一餐**午餐，不是一整天）與體位判定。
   *
   * 正常 = normalKcal；過重 = normalKcal − adjustKcal；過輕 = normalKcal + adjustKcal。
   * 體位分類優先查衛福部兒童青少年建議值（依年齡與性別，見 lib/bmi.js），
   * 查不到年齡或性別時才退回下面這組全校共用的界線。
   */
  intake: {
    normalKcal: 774,
    adjustKcal: 50,
    fallbackUnderweightBmi: 18.5,
    fallbackOverweightBmi: 24,
  },
};

/** 可調參數存放的位置：system_config 集合下的這份文件。*/
const TUNABLE_DOC_ID = 'coin_rules';

// ── 個人餐盤辨識 ────────────────────────────────────────────────────
/**
 * 學生吃完拍一張自己的餐盤 → 模型判斷剩多少 → 依剩餘量給回饋。
 * 模型端點見 lib/plateModel.js；ESG 幣怎麼發、模型回傳格式下一輪定義。
 */
const PLATE = {
  /** 解碼後的照片上限。前端會先縮到長邊 1024px，正常只有一兩百 KB。 */
  maxImageBytes: 3 * 1024 * 1024,
  /**
   * 回饋級距：leftoverRatio（0＝吃光、1＝原封不動）≤ maxRatio 就落在這一級。
   * 依序比對，最後一級要涵蓋到 1。
   */
  feedback: [
    { level: 'clean', maxRatio: 0.05, title: '🌟 全部吃光！', message: '盤子乾乾淨淨，謝謝你把今天的午餐吃完。' },
    { level: 'little', maxRatio: 0.25, title: '👍 只剩一點點', message: '差一點就吃光了，下次挑戰全部吃完！' },
    { level: 'half', maxRatio: 0.5, title: '🙂 剩下約一半', message: '吃不完的話，打菜時可以先跟同學說少一點。' },
    { level: 'most', maxRatio: 1, title: '🤔 剩下不少', message: '今天胃口不太好嗎？下次可以先盛少一點，不夠再添。' },
  ],
};

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

/**
 * 稱重模組的「桶別」綁定選項（技術員面板與裝置設定會帶出桶別名稱）。
 *
 * 這是「一桶一台秤」時代留下的欄位：現在一個班級一台秤、依序稱重，
 * 量哪一道菜由操作者在稱重清單上決定，紀錄流程不再看裝置綁的桶別。
 * 保留它只因為韌體與技術員面板仍會顯示。
 */
const BUCKET_LAYOUT = [
  { id: 'staple', label: '主食桶' },
  { id: 'sideA', label: '配菜桶 A' },
  { id: 'sideB', label: '配菜桶 B' },
  { id: 'soup', label: '湯桶' },
];

/**
 * 桶型。**一個班級一台秤**，量測時一桶一桶輪流放上去，
 * 所以皮重按桶型登錄一次、全校共用（同款桶空重一樣）。
 * 這道菜裝在哪一種容器裡，只為了扣皮重。
 */
const BUCKET_TYPES = [
  { id: 'staple', label: '主食桶', slots: ['staple'] },
  { id: 'dish',   label: '菜桶',   slots: ['main', 'side1', 'side2', 'veg'] },
  { id: 'soup',   label: '湯桶',   slots: ['soup'] },
];

/** 菜色欄位 → 桶型。由 BUCKET_TYPES 推導，避免兩邊各寫一份而走樣。 */
const SLOT_BUCKET_TYPE = BUCKET_TYPES.reduce((acc, t) => {
  t.slots.forEach((s) => { acc[s] = t.id; });
  return acc;
}, {});

/** 桶型皮重存放的位置：system_config 下的這份文件。 */
const BUCKET_TARE_DOC_ID = 'bucket_tare';

/** 菜單的六個欄位，也是稱重順序：主食桶 → 四個菜桶 → 湯桶，換桶次數最少。 */
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
  /** 一位學生一天一筆餐盤辨識（重拍會覆蓋） */
  plateScan: (date, userId) => `${date}_${userId}`,
  /**
   * 一台裝置的一筆讀數。裝置離線補傳時會用同一個 readingId 重試，
   * 決定性 id 讓重試自然覆蓋，不會變成兩筆。
   */
  deviceReading: (deviceId, readingId) => `${deviceId}_${readingId}`,
};

module.exports = {
  ESG,
  TUNABLE_DEFAULTS,
  TUNABLE_DOC_ID,
  COL,
  DEVICE,
  ROLES,
  ALL_ROLES,
  SELF_REGISTER_ROLES,
  COIN_HOLDER_ROLES,
  COIN_RULES,
  PLATE,
  SUPPORT,
  BUCKET_LAYOUT,
  BUCKET_TYPES,
  SLOT_BUCKET_TYPE,
  BUCKET_TARE_DOC_ID,
  MENU_SLOTS,
  SLOT_LABEL,
  SLOT_CATEGORY,
  ids,
};
