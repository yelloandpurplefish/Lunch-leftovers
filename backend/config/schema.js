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
  STUDENT: 'student',           // 拍餐盤（決定當天的 ESG 幣）、兌換、抽獎（午餐長另加稱重紀錄）
  PARENT: 'parent',             // 簽到、查看孩子午餐狀況（無幣系統）
  TEACHER: 'teacher',           // 看本班的餐盤結果；也能做本班稱重紀錄
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
 * 只有一種幣：ESG 幣。餘額只有 users.esgCoin 一個欄位，只有學生持有。
 *
 * 總帳每一筆記 coin:'ESG'，獲得與調整再用 source 標出是哪一種活動給的，
 * 餘額是一個數字，而「ESG 從哪裡來」仍查得到。消耗（兌換、抽獎）的 source 是 null。
 *
 * 目前的發幣只有下面這些（使用者指定，勿擅自加項）：
 *   · 拍餐盤：依辨識出的剩餘量級距給（額度見 TUNABLE_DEFAULTS.plate.rewards）
 *   · 家長簽到：綁定的學生 +1
 * 稱重紀錄是單純的全班剩食紀錄，不發幣。
 */
const ESG = 'ESG';

const COIN_SOURCES = {
  plate: '拍餐盤',
  parent: '家長簽到',
  admin: '管理員調整',
};

const COIN_RULES = {
  /** 家長簽到 → **綁定的學生** +1（每位家長每日一次）*/
  PARENT_SIGN_IN: 1,
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
   * 拍餐盤的 ESG 幣：四個級距各給多少（級距的界線見下方 PLATE.tiers）。
   * 數字是暫定值，學校可以在管理員面板調整；改了之後只影響之後的結果，
   * 已經發出的不會重算。
   */
  plate: {
    rewards: { clean: 10, little: 6, half: 3, most: 0 },
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
 * 學生吃完拍一張自己的餐盤 → 模型判斷剩多少 → 落在哪一級 → 回饋與 ESG 幣。
 * 這是當天「吃得怎麼樣」的唯一依據（不再有老師勾選）。
 * 一人一天只能拍一次；辨識錯了由管理員手動更正（見 lib/plates.js）。
 */
const PLATE = {
  /** 解碼後的照片上限。前端會先縮到長邊 1024px，正常只有一兩百 KB。 */
  maxImageBytes: 3 * 1024 * 1024,
  /**
   * 級距（使用者指定）：剩餘百分比四捨五入成整數後，落在 [minPct, maxPct] 就是這一級。
   * 四級首尾相接、涵蓋 0–100，不會有落空的百分比。
   */
  tiers: [
    { level: 'clean', label: '光盤', minPct: 0, maxPct: 3,
      title: '🌟 光盤！', message: '盤子乾乾淨淨，謝謝你把今天的午餐吃完。' },
    { level: 'little', label: '剩一點', minPct: 4, maxPct: 20,
      title: '👍 只剩一點點', message: '差一點就光盤了，下次挑戰全部吃完！' },
    { level: 'half', label: '剩不少', minPct: 21, maxPct: 49,
      title: '🙂 剩下不少', message: '吃不完的話，打菜時可以先跟同學說少一點。' },
    { level: 'most', label: '剩一半以上', minPct: 50, maxPct: 100,
      title: '🤔 剩一半以上', message: '今天胃口不太好嗎？下次可以先盛少一點，不夠再添。' },
  ],
};

/** 剩餘百分比 → 級距（不在 0–100 的先夾住）。 */
function plateTier(pct) {
  const p = Math.min(100, Math.max(0, Math.round(Number(pct) || 0)));
  return PLATE.tiers.find((t) => p >= t.minPct && p <= t.maxPct) || PLATE.tiers[PLATE.tiers.length - 1];
}

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
  /** 一位家長一天只能簽到一次 */
  parentSignIn: (date, parentId) => `${date}_${parentId}`,
  /** 一班一天一場量測 */
  mealSession: (classId, date) => `${classId}_${date}`,
  /** 一班一天一道菜（以菜單欄位為鍵，同一餐不會重複）*/
  dishLeftover: (classId, date, slot) => `${classId}_${date}_${slot}`,
  /** 一位學生一天一筆餐盤結果（學生只能拍一次，管理員可以改） */
  plateScan: (date, userId) => `${date}_${userId}`,
  /**
   * 一台裝置的一筆讀數。裝置離線補傳時會用同一個 readingId 重試，
   * 決定性 id 讓重試自然覆蓋，不會變成兩筆。
   */
  deviceReading: (deviceId, readingId) => `${deviceId}_${readingId}`,
};

module.exports = {
  ESG,
  COIN_SOURCES,
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
  plateTier,
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
