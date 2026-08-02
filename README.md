# 食安守護者後端 API

## 📋 專案概述

食安守護者的後端 API，使用 Node.js + Express + Firebase Firestore 建構。

## 🚀 快速開始

### 1. 安裝依賴

```bash
cd backend
npm install
```

### 2. Firebase 設定

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 建立新專案或選擇現有專案
3. 啟用 Firestore Database
4. 啟用 Authentication
5. 下載 Service Account Key：
   - 點擊專案設定 → 服務帳戶
   - 點擊「產生新的私密金鑰」
   - 下載 JSON 檔案並重新命名為 `service-account-key.json`
   - 將檔案放在 `backend/` 目錄下
6. **重要：** 不要將 `service-account-key.json` 提交到 Git

### 3. 環境變數設定

複製 `.env.example` 為 `.env`：

```bash
cp .env.example .env
```

編輯 `.env` 檔案，填入你的 Firebase 設定：

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-client-email
FIREBASE_PRIVATE_KEY=your-private-key
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com

JWT_SECRET=your-jwt-secret-key-here

PORT=3000
NODE_ENV=development
```

### 4. 啟動伺服器

開發模式（自動重啟）：
```bash
npm run dev
```

生產模式：
```bash
npm start
```

伺服器將在 `http://localhost:3000` 啟動

## 📁 專案結構

```
backend/
├── config/
│   └── firebase.js          # Firebase 設定
├── controllers/
│   ├── authController.js    # 認證控制器
│   ├── userController.js    # 使用者控制器
│   ├── taskController.js    # 任務控制器
│   ├── lotteryController.js # 抽獎控制器
│   ├── exchangeController.js # 兌換控制器
│   ├── leaderboardController.js # 排行榜控制器
│   └── analysisController.js # 分析控制器
├── middleware/
│   └── auth.js              # 認證中介軟體
├── routes/
│   ├── auth.js              # 認證路由
│   ├── user.js              # 使用者路由
│   ├── task.js              # 任務路由
│   ├── lottery.js           # 抽獎路由
│   ├── exchange.js          # 兌換路由
│   ├── leaderboard.js       # 排行榜路由
│   └── analysis.js          # 分析路由
├── .env                     # 環境變數（不提交到 Git）
├── .env.example             # 環境變數範本
├── package.json             # 專案依賴
├── server.js                # 主伺服器檔案
└── service-account-key.json # Firebase Service Key（不提交到 Git）
```

## 🔌 API 端點

### 認證相關

- `POST /api/auth/register` - 註冊新使用者
- `POST /api/auth/login` - 使用者登入
- `POST /api/auth/logout` - 使用者登出

### 使用者相關

- `GET /api/user/profile` - 獲取使用者資料
- `PUT /api/user/profile` - 更新使用者資料
- `PUT /api/user/last-login` - 更新最後登入時間

### 任務相關

- `POST /api/task/complete-light-disc` - 完成光盤行動
- `POST /api/task/claim-leftover-reward` - 領取剩食獎勵
- `POST /api/task/submit-survey` - 提交問卷

### 抽獎相關

- `POST /api/lottery/spin` - 進行抽獎
- `GET /api/lottery/history` - 獲取抽獎歷史

### 兌換相關

- `POST /api/exchange/redeem` - 兌換物品
- `GET /api/exchange/items` - 獲取可兌換物品列表
- `GET /api/exchange/history` - 獲取兌換歷史

### 排行榜相關

- `GET /api/leaderboard` - 獲取排行榜

### 分析相關

- `POST /api/analysis/submit` - 提交剩食分析
- `GET /api/analysis/stats` - 獲取剩食統計（管理員）

## 🔐 認證方式

所有需要認證的 API 都需要在請求標頭中包含 Firebase ID Token：

```
Authorization: Bearer <firebase-id-token>
```

## 🛡️ 安全性

- 使用 Firebase Authentication 進行使用者認證
- Helmet 中介軟體保護 HTTP 標頭
- 速率限制防止濫用
- CORS 設定限制跨來源請求
- 所有關鍵邏輯在後端執行

## 📊 Firestore 資料表

後端會使用以下 Firestore 集合：

- `users` - 使用者資料
- `task_records` - 任務記錄
- `lottery_records` - 抽獎記錄
- `exchange_records` - 兌換記錄
- `leftover_analysis` - 剩食分析
- `reward_items` - 獎勵物品

## 🧪 測試 API

使用 curl 或 Postman 測試 API：

```bash
# 健康檢查
curl http://localhost:3000/health

# 註冊使用者
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","displayName":"測試使用者"}'
```

## 📝 注意事項

1. **Service Account Key 安全：** 絕對不要將 `service-account-key.json` 提交到版本控制系統
2. **環境變數：** 生產環境應使用安全的環境變數管理方式
3. **CORS 設定：** 部署時需要更新 CORS 來源為實際的前端網域
4. **速率限制：** 根據實際需求調整速率限制參數

## 🚀 部署

### 使用 PM2 部署

```bash
npm install -g pm2
pm2 start server.js --name food-guardian-api
pm2 save
pm2 startup
```

### 使用 Docker 部署（可選）

建立 `Dockerfile`：

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

建構和執行：

```bash
docker build -t food-guardian-api .
docker run -p 3000:3000 food-guardian-api
```

## 📞 支援

如有問題，請聯繫開發團隊。
