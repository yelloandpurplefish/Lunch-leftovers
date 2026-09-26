require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const net = require('net');

// 路由
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const taskRoutes = require('./routes/task');
const lotteryRoutes = require('./routes/lottery');
const exchangeRoutes = require('./routes/exchange');
const leaderboardRoutes = require('./routes/leaderboard');
const debugRoutes = require('./routes/debug');
// 新：剩食紀錄（四桶影像辨識）與教師逐生檢查
const recordRoutes = require('./routes/record');
const mealCheckRoutes = require('./routes/mealCheck');
const parentRoutes = require('./routes/parent');
const supportRoutes = require('./routes/support');
const statsRoutes = require('./routes/stats');

// 資料庫初始化
const { initializeDatabase } = require('./config/seed');

const app = express();
const PORT = process.env.PORT || 3000;

// 安全中介軟體
// 註：前端不使用任何內聯 script/onclick，因此無需 'unsafe-inline'
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Firebase SDK 由 gstatic CDN 載入
      scriptSrc: ["'self'", "https://www.gstatic.com"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      // Firebase Auth 需連線 identitytoolkit / securetoken，source map 需 gstatic
      connectSrc: [
        "'self'",
        "https://*.googleapis.com",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://www.gstatic.com"
      ],
      // 允許嵌入 YouTube 影片
      frameSrc: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false // 允許嵌入 YouTube 影片
}));

// CORS 設定
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : (process.env.NODE_ENV === 'production'
    ? ['https://lunch-leftovers.onrender.com']
    : ['http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500']);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// 請求日志（僅開發環境）
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// 解析 JSON
// 四桶辨識要上傳照片（base64），預設的 100kb 會直接擋掉 —— 一張降取樣後的
// 照片約 100~400KB，base64 再膨脹約 1.37 倍，因此放寬到 8mb。
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '8mb' }));

// API 速率限制
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分鐘
  max: process.env.NODE_ENV === 'production' ? 100 : 1000, // 生產環境 100，開發 1000
  message: {
    success: false,
    message: '請求過於頻繁，請稍後再試'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/task', taskRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/record', recordRoutes);
app.use('/api/meal-check', mealCheckRoutes);
app.use('/api/parent', parentRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/stats', statsRoutes);

// 開發/測試端點（僅在非生產環境啟用）
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/debug', debugRoutes);
  console.log('🔧 開發/測試端點已啟用: /api/debug');
}

// 健康檢查
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: '伺服器運行正常',
    timestamp: new Date().toISOString()
  });
});

// 提供靜態文件
app.use(express.static(path.join(__dirname, '..')));

// 處理 SPA 路由 - 所有 GET 非 API 請求都返回 index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '找不到請求的端點'
  });
});

// 錯誤處理中介軟體
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: '照片檔案太大，請降低解析度或壓縮後再上傳'
    });
  }
  console.error('伺服器錯誤:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '伺服器內部錯誤'
  });
});

/**
 * 啟動前先確認 Firestore 連得上。
 *
 * 用 Emulator 時若忘記先開 emulator，firebase-admin 只會丟
 * 「14 UNAVAILABLE: No connection established」這種看不出原因的 gRPC 錯誤，
 * 所以這裡先做一次 TCP 探測，直接告訴使用者要跑哪個指令。
 */
function checkFirestoreReachable() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return Promise.resolve({ ok: true, mode: 'cloud' });

  const [hostname, port] = host.split(':');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) || 8080 });
    const done = (ok) => {
      socket.destroy();
      resolve({ ok, mode: 'emulator', host });
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 啟動伺服器
app.listen(PORT, async () => {
  console.log(`🚀 伺服器運行在 http://localhost:${PORT}`);
  console.log(`📊 健康檢查: http://localhost:${PORT}/health`);
  console.log(`🌐 前端頁面: http://localhost:${PORT}`);

  // 先確認資料庫連得上，再做初始化
  const reachable = await checkFirestoreReachable();
  if (!reachable.ok) {
    console.error('\n' + '='.repeat(64));
    console.error('❌ 連不上 Firestore Emulator（' + reachable.host + '）');
    console.error('');
    console.error('   .env 裡設了 FIRESTORE_EMULATOR_HOST，但那個埠沒有東西在監聽。');
    console.error('   請「另開一個視窗」先啟動 emulator，再重啟本伺服器：');
    console.error('');
    console.error('     cd lunch-leftovers');
    console.error('     npx firebase emulators:start --only firestore --project lunch-leftovers-dev');
    console.error('');
    console.error('   （需要 Java 與 firebase-tools；改用正式 Firebase 專案則把');
    console.error('     FIRESTORE_EMULATOR_HOST 註解掉，並設 FIREBASE_SERVICE_ACCOUNT_KEY）');
    console.error('='.repeat(64) + '\n');
    console.error('⏸  已跳過資料庫初始化。API 仍會回應，但任何讀寫都會失敗。');
    return;
  }

  // 初始化資料庫（基礎資料 + 選用的測試帳號）
  // 失敗不影響伺服器運行，僅記錄錯誤
  await initializeDatabase().catch((error) => {
    const hint = String(error && error.message || '').includes('UNAVAILABLE')
      ? '（看起來是資料庫連線中斷，請確認 emulator 或金鑰設定）'
      : '';
    console.error('❌ 資料庫初始化發生未預期錯誤:', error.message || error, hint);
  });
});

module.exports = app;
