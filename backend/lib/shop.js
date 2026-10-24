/**
 * 商城開關（兌換功能的總閘）。
 *
 * ## 為什麼是兩層
 *
 *   環境變數 SHOP_ENABLED   —— 營運層的硬開關，部署時決定
 *   system_config/shop      —— 管理員面板的日常開關，隨時可切
 *
 * 兩層都要通過才開張。理由是這兩件事的性質不同：
 *   · 「這次部署根本不提供兌換」（示範站、尚未進貨、法遵未過）屬於營運決定，
 *     不該讓任何一個拿到管理員帳號的人在面板上打開。
 *   · 「今天獎品盤點、暫停兌換」屬於日常決定，不該要改環境變數重新部署。
 *
 * 因此 SHOP_ENABLED=false 時面板上的開關會被標成「已被環境變數鎖定」，
 * 打開也沒有用——這比讓面板顯示「已開啟」但實際兌換不了要誠實得多。
 *
 * 預設值為開啟：這是既有功能，不該因為新增了開關就讓現有部署突然關閉。
 */
const { db } = require('../config/firebase');
const { COL } = require('../config/schema');

const DOC_ID = 'shop';
const CACHE_MS = 30 * 1000;

let cache = null;
let cachedAt = 0;

/** 環境變數只在啟動時讀一次：執行中被改動也不該讓行為在請求之間跳動。 */
const ENV_ENABLED = (() => {
  const raw = String(process.env.SHOP_ENABLED == null ? '' : process.env.SHOP_ENABLED)
    .trim().toLowerCase();
  if (!raw) return true;                                  // 沒設定 → 沿用既有行為
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
})();

function invalidateShop() {
  cache = null;
  cachedAt = 0;
}

/**
 * 取得商城狀態。
 * @returns {Promise<{enabled:boolean, envEnabled:boolean, adminEnabled:boolean,
 *                    lockedByEnv:boolean, message:string|null, updatedAt:string|null,
 *                    updatedBy:string|null}>}
 */
async function getShopState({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  let stored = {};
  try {
    const snap = await db.collection(COL.systemConfig).doc(DOC_ID).get();
    if (snap.exists) stored = snap.data() || {};
  } catch (error) {
    // 讀不到設定時維持「開啟」而不是整個壞掉，但要留痕：
    // 商城關不起來比暫時關不掉更容易被發現，無聲地全站關閉才危險。
    console.error('讀取商城開關失敗，暫時沿用預設（開啟）:', error.message);
  }

  const adminEnabled = stored.enabled === undefined ? true : Boolean(stored.enabled);
  const state = {
    enabled: ENV_ENABLED && adminEnabled,
    envEnabled: ENV_ENABLED,
    adminEnabled,
    lockedByEnv: !ENV_ENABLED,
    message: typeof stored.message === 'string' && stored.message.trim()
      ? stored.message.trim() : null,
    updatedAt: stored.updatedAt && stored.updatedAt.toDate
      ? stored.updatedAt.toDate().toISOString() : null,
    updatedBy: stored.updatedByName || null,
  };

  cache = state;
  cachedAt = Date.now();
  return state;
}

/** 關閉時給使用者看的理由：管理員自訂訊息優先，否則給預設說法。 */
function closedReason(state) {
  if (state.message) return state.message;
  if (state.lockedByEnv) return '這個環境沒有開放兌換商城';
  return '商城暫停開放中，請稍後再試';
}

/**
 * 寫入管理員開關。環境變數鎖定時仍可寫入（記錄校方的意圖），
 * 但 getShopState 算出來的 enabled 依然是 false，並以 lockedByEnv 標明原因。
 */
async function setShopEnabled({ enabled, message, uid, displayName }) {
  const { admin } = require('../config/firebase');
  await db.collection(COL.systemConfig).doc(DOC_ID).set({
    enabled: Boolean(enabled),
    message: typeof message === 'string' ? message.trim().slice(0, 200) : '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid || null,
    updatedByName: displayName || null,
  }, { merge: true });
  invalidateShop();
  return getShopState({ force: true });
}

/**
 * 擋下兌換相關請求的中介層。
 * 放在路由層而不是只在前端隱藏：前端藏起來的按鈕用 curl 一樣打得到。
 */
async function requireShopOpen(req, res, next) {
  try {
    const state = await getShopState();
    if (state.enabled) return next();
    return res.status(503).json({
      success: false,
      message: closedReason(state),
      shopClosed: true,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  DOC_ID,
  ENV_ENABLED,
  getShopState,
  setShopEnabled,
  closedReason,
  requireShopOpen,
  invalidateShop,
};
