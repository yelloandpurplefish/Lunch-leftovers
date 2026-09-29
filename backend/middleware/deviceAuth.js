/**
 * 裝置驗證：ESP32 用「裝置 ID + 裝置 token」認證，與使用者的 JWT 完全分開。
 *
 * 為什麼不讓裝置用使用者帳號：
 *  · 裝置會被拆、會被撿走、韌體可被讀出來 —— 它的憑證必須能**單獨撤銷**，
 *    而且外洩時不能拿來讀學生資料。
 *  · 裝置只能打 /api/device/*，打不到任何使用者端點。
 *
 * token 以 SHA-256 存雜湊（不是明碼）。用 SHA-256 而非 bcrypt 是因為
 * token 是 40 字元的高熵隨機字串，不需要抗暴力破解的慢雜湊，
 * 而裝置每次上傳都要驗一次，bcrypt 會讓伺服器 CPU 白白燒掉。
 */
const crypto = require('crypto');
const { db, admin } = require('../config/firebase');
const { COL, DEVICE } = require('../config/schema');

const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ ok: false, error: message, ...extra });

/** token → 雜湊（存進資料庫的是這個）。*/
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 產生新的裝置 token（只會在建立/輪替時回傳一次明碼）。*/
function generateToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(DEVICE.tokenLength);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** 定值時間比較，避免用回應時間去猜 token。*/
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 驗證裝置並掛上 req.device。
 * 標頭：`X-Device-Id` 與 `X-Device-Token`（也接受 Authorization: Device <token>）。
 */
async function authenticateDevice(req, res, next) {
  try {
    const deviceId = String(req.header('x-device-id') || '').trim();
    const authHeader = String(req.header('authorization') || '');
    const token = String(
      req.header('x-device-token') ||
      (authHeader.startsWith('Device ') ? authHeader.slice(7) : '')
    ).trim();

    if (!deviceId || !token) {
      return fail(res, 401, '缺少 X-Device-Id 或 X-Device-Token');
    }

    const snap = await db.collection(COL.devices).doc(deviceId).get();
    if (!snap.exists) {
      // 不區分「裝置不存在」與「token 錯」，避免被拿來枚舉裝置編號
      return fail(res, 401, '裝置未註冊或憑證錯誤');
    }
    const device = snap.data();

    if (!safeEqual(hashToken(token), device.tokenHash || '')) {
      // 記錄失敗次數，技術員頁看得到異常裝置
      await snap.ref.set({
        authFailures: admin.firestore.FieldValue.increment(1),
        lastAuthFailureAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return fail(res, 401, '裝置未註冊或憑證錯誤');
    }

    if (device.status === 'disabled') {
      return fail(res, 403, '此裝置已被停用，請聯絡技術員');
    }

    req.device = { id: snap.id, ...device };
    req.deviceRef = snap.ref;
    return next();
  } catch (error) {
    console.error('裝置驗證失敗:', error);
    return fail(res, 500, '伺服器錯誤');
  }
}

module.exports = { authenticateDevice, hashToken, generateToken };
