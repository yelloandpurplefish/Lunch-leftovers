# 食安守護者 Food Guardian

## 📋 專案概述

食安守護者 - 校園食安教育遊戲化動態網站，使用 HTML5 + JavaScript + Node.js + Express + Firebase Firestore + Firebase Authentication 建構。

這是一個**完整的動態網站**，前端使用 Firebase SDK 進行身份驗證，通過後端 API 操作 Firestore 以保持安全性和權限控制。

## 🚀 快速開始

### 1. Firebase 設定

請參考 [FIREBASE_SETUP.md](FIREBASE_SETUP.md) 詳細設定步驟：

1. 前往 [Firebase Console](https://console.firebase.google.com/) 建立專案
2. 啟用 Authentication (Email/Password)
3. 建立 Firestore 資料庫
4. 下載 Service Account Key
5. 獲取 Firebase 配置並更新 `firebase-config.js`

### 2. 後端設置

```bash
cd backend
npm install
cp .env.example .env
# 編輯 .env 填入 Firebase 配置
```

### 3. 本地運行

```bash
# 啟動後端服務器
cd backend
npm run dev

# 或使用根目錄的腳本
npm run dev
```

然後在瀏覽器中訪問 `http://localhost:3000`

### 4. 部署

請參考 [DEPLOYMENT.md](DEPLOYMENT.md) 了解部署方式：

- **推薦：** Render（已配置 render.yaml）
- **其他選擇：** 手動伺服器部署、Docker

## 📁 專案結構

```
food-guardian/
├── index.html              # 主頁面
├── style.css               # 樣式表
├── app.js                  # 前端 JavaScript 邏輯
├── firebase-config.js      # Firebase 配置
├── FIREBASE_SETUP.md       # Firebase 設置指南
├── DEPLOYMENT.md           # 部署指南
├── .gitignore              # Git 忽略文件
├── package.json            # 專案配置
├── render.yaml             # Render 部署配置
├── backend/                # 後端服務
│   ├── config/
│   │   └── firebase.js     # Firebase Admin SDK 配置
│   ├── controllers/        # 控制器
│   │   ├── authController.js
│   │   ├── userController.js
│   │   ├── taskController.js
│   │   ├── exchangeController.js
│   │   └── ...
│   ├── middleware/
│   │   └── auth.js         # 認證中介軟體
│   ├── routes/            # API 路由
│   │   ├── auth.js
│   │   ├── user.js
│   │   ├── task.js
│   │   └── ...
│   ├── server.js          # 主伺服器
│   ├── package.json       # 後端依賴
│   └── .env.example       # 環境變數範本
└── 專案架構書.md           # 原始架構文檔
```

## ✨ 主要功能

### 🔐 使用者認證
- Email/密碼註冊和登入
- Firebase Authentication（前端）
- Firebase Admin SDK（後端驗證）

### 💰 虛擬貨幣系統
- **E幣：** 主要貨幣，用於兌換和抽獎
- **S幣：** 次要貨幣，用於特定兌換
- **積分：** 排行榜依據
- 後端 API 保護貨幣操作

### 📋 任務系統
- **光盤行動：** 完成午餐光盤獲得獎勵
- **剩食獎勵：** 根據剩食重量計算獎勵
- **問卷系統：** 每日菜色喜好調查
- **24小時冷卻機制**（後端驗證）

### 🎁 兌換商城
- 環保杯 (50 E幣)
- 環保餐具 (80 E幣)
- 文具禮包 (30 S幣)
- 後端 API 進行庫存和餘額檢查

### 🎰 抽獎系統
- 消耗 10 E幣進行抽獎
- 大獎(5%)、普通(30%)、小獎(65%)
- 後端執行隨機邏輯

### 📊 剩食分析
- 分析各項菜色剩食量
- 找出最多/最少剩食
- 提供改進建議

## 🔧 技術棧

### 前端
- **HTML5** - 結構
- **CSS3** - 樣式
- **JavaScript (ES6+)** - 邏輯
- **Firebase SDK v9.22.0** - 僅用於身份驗證

### 後端
- **Node.js + Express** - API 服務器
- **Firebase Admin SDK** - Firestore 操作
- **CORS** - 跨域支持
- **Helmet** - 安全中介軟體
- **Rate Limiting** - 速率限制

### 資料庫
- **Firebase Firestore** - 雲端資料庫
- **Firebase Authentication** - 使用者認證

## 📊 Firestore 資料表

應用程式使用以下 Firestore 集合：

- `users` - 使用者資料 (userId, email, displayName, eCoin, sCoin, score, etc.)
- `task_records` - 任務記錄 (光盤行動、剩食獎勵、問卷)
- `exchange_records` - 兌換記錄
- `lottery_records` - 抽獎記錄
- `leftover_analysis` - 剩食分析

## 🔌 API 端點

### 認證相關
- `POST /api/auth/register` - 註冊新使用者
- `POST /api/auth/login` - 使用者登入
- `POST /api/auth/logout` - 使用者登出

### 使用者相關
- `GET /api/user/profile` - 獲取使用者資料
- `PUT /api/user/profile` - 更新使用者資料

### 任務相關
- `POST /api/task/complete-light-disc` - 完成光盤行動
- `POST /api/task/claim-leftover-reward` - 領取剩食獎勵
- `POST /api/task/submit-survey` - 提交問卷

### 兌換相關
- `POST /api/exchange/redeem` - 兌換物品
- `GET /api/exchange/items` - 獲取可兌換物品列表
- `GET /api/exchange/history` - 獲取兌換歷史

## 🛡️ 安全性

- Firebase Authentication 使用者認證
- 後端 API 保護所有資料操作
- Firebase ID Token 驗證
- Helmet 中介軟體保護 HTTP 標頭
- 速率限制防止濫用
- CORS 設定限制跨來源請求

## 🧪 測試

### 本地測試
1. 完成 Firebase 設置
2. 設置後端環境變數
3. 啟動後端服務器
4. 訪問 `http://localhost:3000`
5. 測試註冊、登入、任務完成等功能

### 功能測試清單
- [ ] 註冊新使用者
- [ ] 使用者登入/登出
- [ ] 完成光盤行動任務
- [ ] 領取剩食獎勵
- [ ] 提交問卷
- [ ] 兌換物品
- [ ] 進行抽獎
- [ ] 查看剩食分析

## 🚀 部署指南

詳細部署步驟請參考 [DEPLOYMENT.md](DEPLOYMENT.md)：

### 推薦方式：Render
1. 推送到 GitHub
2. 在 Render 創建 Web Service
3. 設置環境變數
4. 自動部署

### 其他方式
- 手動伺服器部署
- Docker 容器化部署

## 🐛 故障排除

### 後端啟動失敗
- 檢查 Node.js 版本（需要 v14+）
- 確認已安裝依賴 (`npm install`)
- 檢查環境變數設置
- 查看錯誤日志

### API 連接失敗
- 確認後端服務器正在運行
- 檢查 `firebase-config.js` 中的 API_BASE_URL
- 檢查 CORS 設置
- 查看瀏覽器控制台錯誤

### Firebase 認證失敗
- 檢查 Firebase Authentication 是否已啟用
- 確認 Firebase 配置正確
- 檢查 Service Account Key
- 查看後端日志

### 部署問題
- 參考 [DEPLOYMENT.md](DEPLOYMENT.md) 故障排除部分
- 檢查部署平台日志
- 確認環境變數設置

## 📞 支援

如有問題，請：
1. 查看 [FIREBASE_SETUP.md](FIREBASE_SETUP.md)
2. 查看 [DEPLOYMENT.md](DEPLOYMENT.md)
3. 檢查瀏覽器控制台錯誤信息
4. 檢查後端服務器日志
5. 聯繫開發團隊

## 📄 授權

此專案為教育用途。

## 🙏 致謝

感謝所有為此專案貢獻的人。
