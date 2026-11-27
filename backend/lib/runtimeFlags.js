/**
 * 啟動時依環境變數決定的開關。抽出來是為了能單獨測試，不必真的啟動伺服器。
 */

/**
 * /api/debug 要不要掛上。
 *
 * 原本只看 NODE_ENV !== 'production'；但本機常常不設 NODE_ENV 卻連著正式資料庫，
 * 結果是「不需登入就能在正式庫建帳號、自訂角色」的端點開在區網上。
 * 現在預設只在連模擬器時開；真的要對正式庫開，必須明講 ENABLE_DEBUG_ROUTES=true。
 * NODE_ENV=production 時一律不開。
 */
function debugRoutesEnabled(env = process.env) {
  if (env.NODE_ENV === 'production') return false;
  if (env.ENABLE_DEBUG_ROUTES === 'true') return true;
  return Boolean(env.FIRESTORE_EMULATOR_HOST);
}

/**
 * 餐盤辨識要不要用開發用的假結果（見 lib/plateModel.js）。
 *
 * 真模型還沒接上時，前端流程仍要能從頭走到尾地測。
 * 正式環境一律不給——假結果會被當成真的回饋給學生，下一輪還會拿來發幣。
 * 預設只在連模擬器時開；連正式庫做展示時可以明講 PLATE_MODEL_STUB=true。
 */
function plateStubEnabled(env = process.env) {
  if (env.NODE_ENV === 'production') return false;
  if (env.PLATE_MODEL_STUB === 'true') return true;
  if (env.PLATE_MODEL_STUB === 'false') return false;
  return Boolean(env.FIRESTORE_EMULATOR_HOST);
}

/**
 * TRUST_PROXY → Express 的 'trust proxy' 設定。
 * 放在反向代理（Caddy、Render）後面時要設，req.ip 才會是使用者的 IP 而不是代理的。
 *   未設定      → undefined（不動 Express 預設：不信任）
 *   "1"、"2"…   → 信任幾層代理（建議用數字）
 *   "true"/"false"
 *   其他字串    → 原樣交給 Express（例如 "loopback, 10.0.0.0/8"）
 */
function parseTrustProxy(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

module.exports = { debugRoutesEnabled, plateStubEnabled, parseTrustProxy };
