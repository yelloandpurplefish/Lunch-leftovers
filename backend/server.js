require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// 路由
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const taskRoutes = require('./routes/task');
const lotteryRoutes = require('./routes/lottery');
const exchangeRoutes = require('./routes/exchange');
const leaderboardRoutes = require('./routes/leaderboard');
const analysisRoutes = require('./routes/analysis');
const debugRoutes = require('./routes/debug');

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
app.use(express.json());

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
app.use('/api/analysis', analysisRoutes);

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
  console.error('伺服器錯誤:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '伺服器內部錯誤'
  });
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行在 http://localhost:${PORT}`);
  console.log(`📊 健康檢查: http://localhost:${PORT}/health`);
  console.log(`🌐 前端頁面: http://localhost:${PORT}`);
});

module.exports = app;
