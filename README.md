# 食安守護者 Food Guardian

## 📋 專案概述

食安守護者 - 校園食安教育遊戲化動態網站，使用 HTML5 + JavaScript + Node.js + Express + Firebase Firestore 建構。

這是一個**完整的動態網站**：瀏覽器只呼叫後端 API，由後端驗證身分與權限後才讀寫 Firestore。

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
- 帳號（或 Email）＋密碼註冊和登入，後端簽發 JWT
- 重新整理頁面直接回到 App；登入過期或帳號被停用時自動回登入頁
- 右上角顯示登入者、身分、資料更新時間、⟳ 手動更新與登出

### 💰 ESG 幣
- 只有一種幣：**ESG 幣**，只有學生持有（家長、老師沒有幣系統）
- 來源：**學生拍餐盤的結果**（依剩餘量分四級：光盤 0–3%、剩一點 4–20%、剩不少 21–49%、剩一半以上 50% 以上，
  各級額度在管理員面板調整）、家長每日簽到（+1）
- 拍餐盤一天一次；辨識錯了由管理員更正，幣自動補或收回差額。老師不再逐生勾選「吃完」
- 全班稱重紀錄**不發幣**
- 每一筆增減都和餘額在同一個 transaction 寫進 `coin_transactions` 總帳；管理員面板的「資料檢查」可以核對

### 👥 身分
- 學生、家長、老師、技術員、管理員
- **午餐長不是另一種帳號**：是被指定的學生（`classes.lunchLeaderUserId`），
  學生的功能全部保留，另外多了本班依序稱重紀錄的權限

### 🍱 紀錄與回饋
- **全班剩食紀錄：** 午餐長（或導師）把每道菜的桶子依序放上秤，單純記錄全班剩多少
- **今日午餐（拍餐盤）：** 學生吃完拍一張照片，依剩餘量給回饋與 ESG 幣（模型端點預留中，見 `backend/lib/plateModel.js`）；
  老師可看本班結果（唯讀）
- **管理員專區：** 分頁（總覽／班級／帳號／設定／同步／資料檢查）。先選班級或搜尋帳號再操作；
  可替任何班稱重（秤連不上時手動輸入）、更正任何學生的餐盤結果、調整 ESG、改家長綁定、指定導師與午餐長
- **問卷系統：** 每日菜色喜好調查（24 小時冷卻，後端驗證）

### 🎁 兌換商城
- 以 ESG 幣兌換環保杯、環保餐具、文具禮包等
- 後端 API 進行庫存和餘額檢查

### 🎰 抽獎系統
- 每次消耗 40 ESG 幣
- 大獎 2%、稀有 18%、小獎 80%（後端抽，扣幣與抽獎紀錄在同一個 transaction）

### 📊 剩食分析
- 各班各菜的剩餘量曲線、跨班支援（哪班還有剩）

## 🔧 技術棧

### 前端
- **HTML5 / CSS3 / JavaScript**（`index.html`、`app.js`、`admin.js`，沒有建置步驟）
- 不使用 Firebase SDK：瀏覽器只跟後端說話，登入後拿到後端簽的 JWT

### 後端
- **Node.js + Express** - API 服務器
- **firebase-admin** - 用服務帳戶讀寫 Firestore（不受安全規則限制，權限全在後端判斷）
- **Helmet、CORS、速率限制**

### 資料庫
- **Firebase Firestore**（帳號密碼自己管：bcrypt 雜湊存在 `users`，不使用 Firebase Authentication）

## 📊 Firestore 資料表

集合名稱的唯一來源是 `backend/config/schema.js` 的 `COL`。主要的：

- `users` - 帳號、角色、班級、`esgCoin`（唯一的幣別）
- `account_index` - 帳號／Email → userId（登入查詢與唯一性）
- `classes` - 班級、導師、午餐長（`lunchLeaderUserId`）
- `plate_scans` - 學生每天一筆的餐盤結果（含這筆發了多少幣）
- `meal_sessions`、`dish_leftovers` - 全班稱重紀錄
- `coin_transactions` - ESG 幣總帳（只增不改）
- `daily_menu`、`dishes`、`devices`、`device_readings`、`parent_sign_ins`、`task_records`、
  `reward_items`、`exchange_records`、`lottery_records`、`lottery_announcements`、`system_config`

## 🔌 API 端點

依功能分在 `backend/routes/`（auth、user、plate、record、parent、exchange、lottery、menu、
leaderboard、support、stats、task、admin、tech、device）。秤的端點見 `DEVICE_API.md`。

常用的幾個：
- `POST /api/auth/login` - 登入，回傳 JWT（只含 uid；角色每個請求都從 `users` 重讀）
- `GET /api/user/profile` - 自己的資料（唯讀；前端每 60 秒自動更新時會呼叫）
- `GET /api/plate/today`、`POST /api/plate/scan` - 今日午餐：看結果、拍餐盤
- `GET /api/record/weigh-queue`、`POST /api/record/weigh` - 全班稱重
- `/api/admin/*` - 管理員專區（班級、帳號、餐盤更正、ESG 調整、資料檢查）

## 🛡️ 安全性

- 帳號密碼登入（bcrypt），後端簽 JWT；停用或改角色在下一個請求就生效
- 所有資料操作都經後端，瀏覽器沒有資料庫憑證
- Helmet 安全標頭、CORS 限制來源
- 速率限制：登入後依使用者、未登入依 IP；登入失敗依「帳號＋IP」計次

## 🧪 測試

### 本地測試
1. 完成 Firebase 設置
2. 設置後端環境變數
3. 啟動後端服務器
4. 訪問 `http://localhost:3000`
5. 測試註冊、登入、拍餐盤等功能

### 功能測試清單
- [ ] 註冊新使用者
- [ ] 使用者登入/登出（登出後畫面只剩登入區）
- [ ] 學生拍餐盤、看到回饋與 ESG 幣
- [ ] 午餐長完成全班稱重紀錄
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

### 後端連不上 Firestore
- 檢查 Service Account Key 與專案 ID
- 本機開發可用模擬器（設 `FIRESTORE_EMULATOR_HOST`）
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
