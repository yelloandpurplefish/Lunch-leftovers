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
  /** 班級當餐減碳 → E幣 = round(減碳量 kgCO2e × k_E)，全額加給班上每位學生 */
  k_E: 100,
  /** 完成當日四桶完整辨識 → 班級 +1 S（同樣全額加給每位學生）*/
  FULL_SESSION_CLASS_S: 1,
  /** 基準線移動平均餐數 */
  baselineWindow: 10,
  /** 無歷史時的起步基準：供應量 × 此比例 */
  fallbackBaselineRatio: 0.35,
};

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
};

module.exports = {
  COL,
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
