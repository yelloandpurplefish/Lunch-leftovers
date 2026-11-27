/**
 * API 速率限制。
 *
 * 原本是「每個 IP 每 15 分鐘 100 次（production）」，在這個系統會擋掉正常使用：
 *  1. 學校對外通常只有一個 IP（NAT）；經 Caddy／Render 轉送時若沒設 trust proxy，
 *     後端看到的更全是代理的 IP —— 全校共用 100 次，幾分鐘就用完。
 *  2. 稱重頁每 2 秒更新一次讀數，正常使用 15 分鐘就要約 450 次。
 *
 * 現在：
 *  · 帶有效 token 的請求以「使用者」計次，同一個 NAT 後面的人互不影響
 *  · 沒有 token 的請求（登入、註冊、驗證孩子資料）才以 IP 計次
 *  · /api/device 不在這裡計：它有自己依裝置計的限制（routes/device.js）
 *  · 登入**失敗**另外依「帳號＋IP」計次，放寬總量之後仍然擋得住猜密碼
 *
 * 環境變數：RATE_LIMIT_MAX（每人每 15 分鐘，預設 1000）、LOGIN_FAIL_MAX（預設 10）。
 */
const rateLimit = require('express-rate-limit');
const { uidFromToken } = require('../middleware/auth');

const WINDOW_MS = 15 * 60 * 1000;

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 計次的對象：有效 token → 使用者；否則 → IP。 */
function apiKey(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) {
    const uid = uidFromToken(header.slice(7).trim());
    if (uid) return `u:${uid}`;
  }
  return `ip:${req.ip}`;
}

function isDevicePath(req) {
  return String(req.originalUrl || '').startsWith('/api/device/');
}

function createApiLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: intEnv('RATE_LIMIT_MAX', 1000),
    keyGenerator: apiKey,
    skip: isDevicePath,
    message: { success: false, message: '請求過於頻繁，請稍後再試' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

function createLoginLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: intEnv('LOGIN_FAIL_MAX', 10),
    // 只算失敗（4xx/5xx）；登入成功不佔額度
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const body = req.body || {};
      const id = String(body.account || body.email || '').trim().toLowerCase();
      return `login:${id}:${req.ip}`;
    },
    message: { success: false, message: '這個帳號登入失敗太多次，請 15 分鐘後再試' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

module.exports = { createApiLimiter, createLoginLimiter, apiKey, WINDOW_MS };
