/**
 * 可調參數（拍餐盤四個級距的 ESG 幣、建議攝取熱量）：讀取、合併、快取、寫回。
 *
 * ## 為什麼要有這一層
 *
 * 發幣額度是學校政策、建議熱量的界線會被主管機關更新，
 * 不該每次調整都要改程式重新部署。因此：
 *
 *   預設值   config/schema.js 的 TUNABLE_DEFAULTS（進版控，是文件也是保底）
 *   覆寫值   Firestore system_config/coin_rules（開發者面板寫入）
 *   實際值   兩者**深度合併** —— 面板只存改過的欄位，其餘沿用預設
 *
 * 深度合併而非整份覆蓋很重要：日後在程式裡新增一個參數時，
 * 已經存在資料庫裡的舊設定不會讓新參數變成 undefined。
 *
 * ## 快取
 *
 * 拍餐盤、首頁菜單每次都會讀參數，每次都打 Firestore 太浪費。
 * 快取 60 秒，面板寫入時立即失效——調完馬上就能看到效果，
 * 不會讓人以為「改了沒反應」而重複亂調。
 */
const { db, admin } = require('../config/firebase');
const { COL, TUNABLE_DEFAULTS, TUNABLE_DOC_ID } = require('../config/schema');

const CACHE_MS = 60 * 1000;

let cache = null;
let cachedAt = 0;

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深度合併：override 只覆蓋自己有的欄位，其餘沿用 base。 */
function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined || v === null) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function settingsRef() {
  return db.collection(COL.systemConfig).doc(TUNABLE_DOC_ID);
}

/** 讓下一次讀取重新向資料庫拿。面板寫入後呼叫。 */
function invalidateSettings() {
  cache = null;
  cachedAt = 0;
}

/**
 * 取得實際採用的參數（預設值 ⊕ 資料庫覆寫）。
 * 讀取失敗時回傳純預設值——參數讀不到不該讓拍餐盤或菜單整個失敗，
 * 但會在日誌留痕，否則會變成無聲地用了錯的係數。
 */
async function getSettings({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  try {
    const snap = await settingsRef().get();
    const override = snap.exists ? snap.data() : null;
    // 存著的值也要過一次驗證：只採用目前認得的參數，
    // 已經拿掉的舊參數（例如改版前的感謝額度）不會混進來
    cache = deepMerge(TUNABLE_DEFAULTS, validateTunables((override && override.values) || {}).values);
  } catch (error) {
    console.error('讀取發幣參數失敗，改用預設值:', error.message);
    cache = TUNABLE_DEFAULTS;
  }
  cachedAt = Date.now();
  return cache;
}

/** 數值欄位的合法範圍。超出範圍多半是手滑打錯，寧可擋下也不要默默發錯幣。 */
const LIMITS = {
  'plate.rewards.clean': [0, 1000],
  'plate.rewards.little': [0, 1000],
  'plate.rewards.half': [0, 1000],
  'plate.rewards.most': [0, 1000],
  'intake.normalKcal': [0, 5000],
  // 調整量不設上限為 normalKcal 的一半，是因為面板可能先改這個再改那個；
  // 真正不合理的組合（調整量 > 基準）在算出來時夾在 0 以上，見 lib/bmi.js
  'intake.adjustKcal': [0, 2000],
  'intake.fallbackUnderweightBmi': [5, 60],
  'intake.fallbackOverweightBmi': [5, 60],
};

/**
 * 驗證面板送來的參數。
 * 只接受已知路徑與數字，未知欄位直接忽略——面板是管理員用的，
 * 但仍不該讓任意鍵值寫進發幣與建議值的輸入。
 */
function validateTunables(input) {
  const errors = [];
  const out = {};

  const num = (path, raw, range) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      errors.push(`${path} 不是有效數字`);
      return null;
    }
    const [lo, hi] = range;
    if (v < lo || v > hi) {
      errors.push(`${path} 需介於 ${lo} 與 ${hi} 之間（收到 ${v}）`);
      return null;
    }
    return v;
  };

  // 依 LIMITS 的路徑逐一取值：只有列在那裡的參數會被接受
  for (const [path, range] of Object.entries(LIMITS)) {
    const keys = path.split('.');
    const raw = keys.reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), input);
    if (raw === undefined || raw === null || raw === '') continue;
    const v = num(path, raw, range);
    if (v === null) continue;
    let node = out;
    keys.slice(0, -1).forEach((k) => { node[k] = node[k] || {}; node = node[k]; });
    node[keys[keys.length - 1]] = v;
  }

  return { values: out, errors };
}

/**
 * 寫入覆寫值。只存「與預設不同」的部分，讀取時再合併回來。
 * 一併記錄是誰改的與改了什麼，係數異動會直接影響全校發幣，必須留痕。
 */
async function saveSettings(input, { uid = null } = {}) {
  const { values, errors } = validateTunables(input || {});
  if (errors.length) {
    const err = new Error(errors.join('；'));
    err.status = 400;
    throw err;
  }
  const prev = await getSettings({ force: true });
  await settingsRef().set({
    values,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid,
  }, { merge: false });
  invalidateSettings();
  const next = await getSettings({ force: true });
  return { previous: prev, current: next, saved: values };
}

module.exports = {
  getSettings,
  saveSettings,
  validateTunables,
  invalidateSettings,
  deepMerge,
  TUNABLE_DEFAULTS,
};
