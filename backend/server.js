require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const net = require('net');

// 路由
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const taskRoutes = require('./routes/task');
const lotteryRoutes = require('./routes/lottery');
const exchangeRoutes = require('./routes/exchange');
const menuRoutes = require('./routes/menu');
const leaderboardRoutes = require('./routes/leaderboard');
const debugRoutes = require('./routes/debug');
// 全班剩食紀錄（午餐長依序稱重）、學生個人餐盤辨識
const recordRoutes = require('./routes/record');
const plateRoutes = require('./routes/plate');
const parentRoutes = require('./routes/parent');
const supportRoutes = require('./routes/support');
const statsRoutes = require('./routes/stats');
// 管理員/開發者：手動維護班級與帳號
const adminRoutes = require('./routes/admin');
// IoT：ESP32 稱重模組與技術員專區
const deviceRoutes = require('./routes/device');
const technicianRoutes = require('./routes/technician');

// 資料庫初始化
const { initializeDatabase } = require('./config/seed');
const { checkIndexesOnStartup } = require('./lib/indexCheck');
const { createApiLimiter, createLoginLimiter } = require('./lib/rateLimit');
const { debugRoutesEnabled, parseTrustProxy } = require('./lib/runtimeFlags');

const app = express();
const PORT = process.env.PORT || 3000;

// 在反向代理（Caddy、Render）後面時設 TRUST_PROXY=1，
// 否則 req.ip 全是代理的位址，以 IP 計次的限制會變成大家共用一份。
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// 安全中介軟體
// 註：前端不使用任何內聯 script/onclick，因此 script-src 無需 'unsafe-inline'。
//     style 也一樣：原本散在 HTML 裡的 6 個 style 屬性已搬進 style.css，
//     因為 style-src 'self' 會讓 style 屬性被瀏覽器直接丟掉——跑版而且不報錯。
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
      /**
       * upgrade-insecure-requests 只有在前面真的有 HTTPS 時才該送。
       *
       * 它會把所有 http:// 子資源改寫成 https://。若伺服器是在校內區網以
       * 純 HTTP 提供（例如 http://192.168.1.50:3000），瀏覽器就會去抓
       * https://192.168.1.50:3000/app.js → ERR_SSL_PROTOCOL_ERROR →
       * 腳本全部載不進來，整個頁面變成空殼。API 本身是通的，所以很難查。
       * localhost 是「可信任來源」豁免於這個升級，因此本機開發察覺不到。
       *
       * 預設不送；部署在 Caddy / Render 等 HTTPS 之後時設 HTTPS_UPGRADE=true。
       */
      upgradeInsecureRequests:
        String(process.env.HTTPS_UPGRADE || '').toLowerCase() === 'true' ? [] : null
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
// 學生拍餐盤要上傳照片（base64），預設的 100kb 會直接擋掉 —— 前端縮圖後
// 約 100~400KB，base64 再膨脹約 1.37 倍，因此放寬到 8mb。
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '8mb' }));

// API 速率限制：登入後以使用者計次，未登入以 IP 計次（細節見 lib/rateLimit.js）
app.use('/api/', createApiLimiter());
// 登入失敗另外依帳號計次：總量放寬後仍擋得住對單一帳號猜密碼
app.use('/api/auth/login', createLoginLimiter());

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/task', taskRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/record', recordRoutes);
app.use('/api/plate', plateRoutes);
app.use('/api/parent', parentRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/tech', technicianRoutes);

// 開發/測試端點：不需登入就能建帳號，所以預設只在連模擬器時開（見 lib/runtimeFlags.js）
if (debugRoutesEnabled()) {
  app.use('/api/debug', debugRoutes);
  console.log('🔧 開發/測試端點已啟用: /api/debug');
} else if (process.env.NODE_ENV !== 'production') {
  console.log('🔒 開發/測試端點未啟用：沒有連模擬器（真的要開請設 ENABLE_DEBUG_ROUTES=true）');
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

  // 複合索引檢查。缺索引時 Firestore 回的錯誤裡就帶著建立連結，
  // 這裡把那個連結原樣印出來（見 lib/indexCheck.js）。
  // 不會丟例外、也不會擋住伺服器；INDEX_CHECK=off 可關閉。
  await checkIndexesOnStartup(require('./config/firebase').db);
});

module.exports = app;
