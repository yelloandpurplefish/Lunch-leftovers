# 食安守護者 Food Guardian

## 📋 專案概述

食安守護者 - 校園食安教育遊戲化應用，使用 HTML5 + JavaScript + Firebase Firestore + Firebase Authentication 建構。

## 🚀 快速開始

### 1. Firebase 設定

請參考 [FIREBASE_SETUP.md](FIREBASE_SETUP.md) 詳細設定步驟：

1. 前往 [Firebase Console](https://console.firebase.google.com/) 建立專案
2. 啟用 Authentication (Email/Password)
3. 建立 Firestore 資料庫
4. 獲取 Firebase 配置並更新 `firebase-config.js`
5. 設置 Firestore 安全規則

### 2. 本地運行

直接在瀏覽器中打開 `index.html` 即可開始使用。

### 3. 部署

請參考 [DEPLOYMENT.md](DEPLOYMENT.md) 了解不同的部署方式：

- **推薦：** Firebase Hosting
- **其他選擇：** GitHub Pages, Vercel, Netlify, Render

## 📁 專案結構

```
food-guardian/
├── index.html              # 主頁面
├── style.css               # 樣式表
├── app.js                  # 主要 JavaScript 邏輯
├── firebase-config.js      # Firebase 配置
├── FIREBASE_SETUP.md       # Firebase 設置指南
├── DEPLOYMENT.md           # 部署指南
├── .gitignore              # Git 忽略文件
├── package.json            # 專案配置
├── render.yaml             # Render 部署配置
├── backend/                # 可選的後端服務
│   ├── config/
│   │   └── firebase.js     # Firebase Admin SDK 配置
│   ├── controllers/        # 控制器
│   ├── middleware/         # 中介軟體
│   ├── routes/            # API 路由
│   ├── server.js          # 主伺服器
│   ├── package.json       # 後端依賴
│   └── .env.example       # 環境變數範本
└── 專案架構書.md           # 原始架構文檔
```

## ✨ 主要功能

### 🔐 使用者認證
- Email/密碼註冊和登入
- Firebase Authentication
- Firestore 存儲使用者資料

### 💰 虛擬貨幣系統
- **E幣：** 主要貨幣，用於兌換和抽獎
- **S幣：** 次要貨幣，用於特定兌換
- **積分：** 排行榜依據

### 📋 任務系統
- **光盤行動：** 完成午餐光盤獲得獎勵
- **剩食獎勵：** 根據剩食重量計算獎勵
- **問卷系統：** 每日菜色喜好調查
- **24小時冷卻機制**

### 🎁 兌換商城
- 環保杯 (50 E幣)
- 環保餐具 (80 E幣)
- 文具禮包 (30 S幣)

### 🎰 抽獎系統
- 消耗 10 E幣進行抽獎
- 大獎(5%)、普通(30%)、小獎(65%)

### 📊 剩食分析
- 分析各項菜色剩食量
- 找出最多/最少剩食
- 提供改進建議

## 🔧 技術棧

### 前端
- **HTML5** - 結構
- **CSS3** - 樣式
- **JavaScript (ES6+)** - 邏輯
- **Firebase SDK v12.17.0** - Firebase 服務

### 後端（可選）
- **Node.js + Express** - API 服務器
- **Firebase Admin SDK** - 管理功能
- **Firestore** - 資料庫

### 資料庫
- **Firebase Firestore** - 雲端資料庫
- **Firebase Authentication** - 使用者認證

## 📊 Firestore 資料表

應用程式使用以下 Firestore 集合：

- `users` - 使用者資料 (userId, email, displayName, eCoin, sCoin, score, etc.)
- `task_records` - 任務記錄 (光盤行動、剩食獎勵、問卷)
- `exchange_records` - 兌換記錄

## 🛡️ 安全性

- Firebase Authentication 使用者認證
- Firestore 安全規則保護資料
- 客戶端直接訪問 Firebase（無需後端）
- API Key 限制設置

## 🧪 測試

### 本地測試
1. 完成 Firebase 設置
2. 打開 `index.html`
3. 測試註冊、登入、任務完成等功能

### 功能測試清單
- [ ] 註冊新使用者
- [ ] 使用者登入/登出
- [ ] 完成光盤行動任務
- [ ] 領取剩食獎勵
- [ ] 提交問卷
- [ ] 兌換物品
- [ ] 進行抽獎
- [ ] 查看剩食分析

## 📝 後端服務（可選）

如果您需要管理功能或額外的 API 端點，可以啟用後端服務：

```bash
cd backend
npm install
cp .env.example .env
# 編輯 .env 填入環境變數
npm start
```

後端提供：
- 管理員功能
- 數據統計和分析
- 高級 API 端點

## 🚀 部署指南

詳細部署步驟請參考 [DEPLOYMENT.md](DEPLOYMENT.md)：

### 推薦方式：Firebase Hosting
```bash
npm install -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```

### 其他方式
- GitHub Pages
- Vercel
- Netlify
- Render (已配置 render.yaml)

## 🐛 故障排除

### Firebase 連接問題
- 檢查 `firebase-config.js` 配置是否正確
- 確認 Firebase Console 中已啟用相應服務
- 檢查網絡連接

### 權限錯誤
- 檢查 Firestore 安全規則
- 確認使用者已登入
- 檢查 API Key 限制

### 部署問題
- 參考 [DEPLOYMENT.md](DEPLOYMENT.md) 故障排除部分
- 檢查部署平台日志

## 📞 支援

如有問題，請：
1. 查看 [FIREBASE_SETUP.md](FIREBASE_SETUP.md)
2. 查看 [DEPLOYMENT.md](DEPLOYMENT.md)
3. 檢查瀏覽器控制台錯誤信息
4. 聯繫開發團隊

## 📄 授權

此專案為教育用途。

## 🙏 致謝

感謝所有為此專案貢獻的人。
