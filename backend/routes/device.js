/**
 * ESP32 稱重模組專用路由（裝置憑證，不吃使用者 JWT）。
 * 裝置只能打這三支，碰不到任何使用者資料。
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { hello, heartbeat, measure } = require('../controllers/deviceController');
const { authenticateDevice } = require('../middleware/deviceAuth');

// 裝置的流量特性與使用者不同：每台每分鐘可能上傳數筆，但不該無限制。
// 以裝置 ID 為 key，一台壞掉狂送不會拖垮其他裝置。
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => String(req.header('x-device-id') || req.ip),
  message: { ok: false, error: '上傳過於頻繁，請降低取樣頻率' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(deviceLimiter);
router.use(authenticateDevice);

router.post('/hello', hello);
router.post('/heartbeat', heartbeat);
router.post('/measure', measure);

module.exports = router;
