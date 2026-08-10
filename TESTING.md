# 測試指南

## 🧪 測試環境設置

### 1. 安裝依賴

```bash
# 安裝所有依賴（包含後端）
npm install
```

### 2. 設置環境變數

```bash
cd backend
cp .env.example .env
```

編輯 `.env` 文件，填入您的 Firebase 配置：

```env
# 伺服器配置
PORT=3000
NODE_ENV=development

# Firebase Admin SDK 配置
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com

# 或者使用環境變數
# FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
```

將 Firebase Service Account Key JSON 文件放在 `backend/service-account-key.json`。

### 3. 設置 Firebase 配置

編輯 `firebase-config.js`，填入您的 Firebase 專案配置：

```javascript
const firebaseConfig = {
  apiKey: "your-api-key",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.appspot.com",
  messagingSenderId: "your-messaging-sender-id",
  appId: "your-app-id"
};
```

## 🚀 啟動服務器

### 開發模式（自動重啟）

```bash
npm run dev
```

### 生產模式

```bash
npm start
```

服務器將在 `http://localhost:3000` 啟動

## 🔥 測試 Firebase 串接

### 方法 1：使用後端測試端點

啟動服務器後，訪問：

```bash
curl http://localhost:3000/api/debug/firebase
```

預期回應：
```json
{
  "success": true,
  "message": "Firebase 連接測試完成",
  "auth": { "success": true, "message": "Auth 連接正常" },
  "firestore": { "success": true, "message": "Firestore 連接正常", "userCount": 0 },
  "projectId": "your-project-id"
}
```

### 方法 2：使用命令列腳本

```bash
npm run test:firebase
```

如果 Firestore 連接成功，會顯示 `Firestore OK`。

### 常見問題

**Firebase 未初始化**
- 確認 `backend/.env` 或環境變數設置正確
- 確認 `backend/service-account-key.json` 存在且有效
- 確認 `FIREBASE_DATABASE_URL` 正確

## �️ 資料庫自動初始化

伺服器每次啟動都會自動寫入基礎資料，無需任何設定：

| 集合 | 內容 | 行為 |
|------|------|------|
| `reward_items` | 環保杯、環保餐具、文具禮包 | `merge` 寫入，不覆寫管理員手動調整 |
| `system_config` | 抽獎成本、冷卻時間、獎勵級距 | `merge` 寫入 |
| `daily_menu` | 當日菜單（以日期為文件 ID） | 已存在則跳過 |

> Firestore 是 schemaless 的，集合在首次寫入時自動建立，因此「建立資料表」實際上就是寫入初始資料。
> `task_records`、`exchange_records`、`lottery_records` 等交易紀錄不需預先建立，會在使用者操作時產生。

啟動時會看到：

```
🌱 開始初始化資料庫...
  ✓ reward_items：3 筆
  ✓ system_config：4 筆
  ✓ daily_menu：已建立 2026-08-10
  ⏭️  測試帳號未啟用（設定 SEED_TEST_ACCOUNTS=true 以建立）
✅ 資料庫初始化完成
```

## 👥 建立測試帳號

測試帳號**預設關閉**，需明確開啟。密碼一律由環境變數提供，程式中不含任何預設密碼。

### 設定

在 `backend/.env` 加入：

```env
SEED_TEST_ACCOUNTS=true
TEST_USER_PASSWORD=你的密碼至少12字元
```

### 方法 1：隨伺服器啟動自動建立

```bash
npm start
```

### 方法 2：手動執行（不啟動伺服器）

```bash
npm run seed
```

### 建立的帳號

| Email | 角色 | E幣 | S幣 | 積分 |
|-------|------|-----|-----|------|
| dev@lunch-leftovers.local | admin | 1000 | 500 | 10000 |
| qa@lunch-leftovers.local | admin | 1000 | 500 | 10000 |
| teacher@lunch-leftovers.local | teacher | 500 | 300 | 5000 |
| student@lunch-leftovers.local | student | 100 | 50 | 1000 |

所有帳號共用 `TEST_USER_PASSWORD` 的密碼，並標記 `isTestAccount: true` 方便日後批次清理。

### 安全防護機制

| 條件 | 結果 |
|------|------|
| 未設定 `SEED_TEST_ACCOUNTS=true` | 跳過建立 |
| 未設定 `TEST_USER_PASSWORD` | 拒絕建立並警告 |
| 密碼少於 12 字元 | 拒絕建立 |
| `NODE_ENV=production` | 阻擋，除非另設 `ALLOW_PRODUCTION_TEST_ACCOUNTS=true` |
| 帳號已存在 | 跳過建立，但補齊 Firestore 資料 |

### ⚠️ 安全提醒

- 測試帳號為共用憑證，僅供開發環境
- 正式上線前請在 Firebase Console 刪除所有 `isTestAccount: true` 的帳號
- 請勿將 `backend/.env` 提交到 Git（已在 `.gitignore` 中）
- `/api/debug` 端點在 `NODE_ENV=production` 時自動禁用

## 🧪 功能測試

### 1. 健康檢查

```bash
curl http://localhost:3000/health
```

預期回應：
```json
{
  "success": true,
  "message": "伺服器運行正常",
  "timestamp": "2026-08-04T00:00:00.000Z"
}
```

### 2. 使用者註冊

**測試步驟：**
1. 在瀏覽器中打開 `http://localhost:3000`
2. 點擊「註冊」標籤
3. 填寫註冊表單：
   - 顯示名稱：測試用戶
   - Email：test@example.com
   - 密碼：123456
   - 確認密碼：123456
4. 點擊「註冊」按鈕

**預期結果：**
- 成功註冊並自動登入
- 顯示歡迎訊息
- 用戶資料創建在 Firestore

**API 測試：**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "123456",
    "displayName": "測試用戶"
  }'
```

### 3. 使用者登入

**測試步驟：**
1. 登出（如果已登入）
2. 點擊「登入」標籤
3. 填寫登入表單：
   - Email：test@example.com
   - 密碼：123456
4. 點擊「登入」按鈕

**預期結果：**
- 成功登入
- 顯示歡迎訊息
- 載入用戶資料

### 4. 完成光盤行動任務

**測試步驟：**
1. 點擊「開始使用」
2. 在任務區域點擊「完成午餐光碟行動」
3. 檢查是否收到獎勵

**預期結果：**
- E幣 +10
- S幣 +5
- 積分 +30
- 顯示成功訊息
- 24小時內無法再次領取

**API 測試：**
```bash
# 首先需要獲取 Firebase ID Token
# 然後測試 API
curl -X POST http://localhost:3000/api/task/complete-light-disc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <firebase-id-token>"
```

### 5. 兌換物品

**測試步驟：**
1. 在兌換商城點擊「環保杯」的「兌換」按鈕
2. 檢查 E幣是否扣除

**預期結果：**
- E幣 -50
- 顯示成功訊息
- 兌換記錄創建

### 6. 提交問卷

**測試步驟：**
1. 填寫最喜歡/最不喜歡的菜色
2. 點擊「提交」按鈕

**預期結果：**
- 顯示成功訊息
- 問卷記錄創建
- 24小時內無法再次提交

### 7. 剩食獎勵

**測試步驟：**
1. 在午餐長專區填寫剩食克數
2. 填寫總剩食重量
3. 點擊「領取今日獎勵」

**預期結果：**
- 根據剩食重量獲得相應獎勵
- 顯示成功訊息
- 24小時冷卻

## 🔍 數據驗證

### 檢查 Firestore 資料

在 Firebase Console 中檢查以下集合：

#### users 集合
應該包含用戶文檔：
```json
{
  "userId": "uid",
  "email": "test@example.com",
  "displayName": "測試用戶",
  "eCoin": 數值,
  "sCoin": 數值,
  "score": 數值,
  "createdAt": timestamp,
  "lastLoginAt": timestamp,
  "role": "student",
  "isActive": true
}
```

#### task_records 集合
應該包含任務記錄：
```json
{
  "userId": "uid",
  "taskType": "light_disc",
  "completedAt": timestamp,
  "rewards": {
    "eCoin": 10,
    "sCoin": 5,
    "score": 30
  },
  "metadata": {}
}
```

#### exchange_records 集合
應該包含兌換記錄：
```json
{
  "userId": "uid",
  "itemName": "環保杯",
  "itemType": "E",
  "cost": 50,
  "exchangedAt": timestamp,
  "status": "completed"
}
```

## 🐛 常見問題排查

### 1. 後端啟動失敗

**症狀：** `npm start` 失敗

**解決方案：**
- 檢查 Node.js 版本（需要 v14+）
- 確認已安裝依賴：`npm install`
- 檢查環境變數設置
- 查看錯誤日志

### 2. Firebase 連接失敗

**症狀：** 前端無法連接 Firebase

**解決方案：**
- 檢查 `firebase-config.js` 配置
- 確認 Firebase Console 中已啟用相應服務
- 檢查網絡連接
- 查看瀏覽器控制台錯誤

### 3. API 請求失敗

**症狀：** 前端無法調用後端 API

**解決方案：**
- 確認後端服務器正在運行
- 檢查 `firebase-config.js` 中的 `API_BASE_URL`
- 檢查 CORS 設置
- 查看瀏覽器控制台網絡錯誤

### 4. 認證失敗

**症狀：** 無法登入或註冊

**解決方案：**
- 檢查 Firebase Authentication 是否已啟用 Email/Password
- 確認 Firebase 配置正確
- 檢查 Service Account Key（後端）
- 查看後端日志

### 5. 權限錯誤

**症狀：** Firestore 權限錯誤

**解決方案：**
- 檢查 Firestore 安全規則
- 確認 Service Account Key 正確
- 檢查環境變數設置
- 查看後端日志

## 📊 性能測試

### 1. API 響應時間

```bash
# 測試健康檢查端點
time curl http://localhost:3000/health
```

### 2. 並發請求測試

```bash
# 使用 Apache Bench 進行壓力測試
ab -n 100 -c 10 http://localhost:3000/health
```

## 🎯 測試清單

### 基礎功能
- [ ] 後端服務器正常啟動
- [ ] 健康檢查端點正常
- [ ] 前端頁面正常載入
- [ ] Firebase SDK 正確載入

### 使用者功能
- [ ] 註冊新使用者
- [ ] 使用者登入
- [ ] 使用者登出
- [ ] 載入使用者資料

### 任務系統
- [ ] 完成光盤行動
- [ ] 24小時冷卻機制
- [ ] 獎勵正確發放

### 兌換系統
- [ ] E幣兌換物品
- [ ] S幣兌換物品
- [ ] 餘額正確扣除
- [ ] 兌換記錄創建

### 問卷系統
- [ ] 提交問卷
- [ ] 24小時冷卻機制
- [ ] 問卷記錄創建

### 數據完整性
- [ ] Firestore 資料正確
- [ ] 貨幣餘額同步
- [ ] 任務記錄完整
- [ ] 兌換記錄完整

## 🚀 部署前測試

在部署到生產環境前，確保：

1. **環境變數檢查**
   - [ ] 生產環境 Firebase 配置
   - [ ] API Key 限制設置
   - [ ] CORS 設置正確

2. **安全檢查**
   - [ ] Firestore 安全規則設置
   - [ ] 敏感信息未暴露
   - [ ] Service Account Key 安全

3. **功能檢查**
   - [ ] 所有功能正常工作
   - [ ] 錯誤處理完善
   - [ ] 日志記錄完整

4. **性能檢查**
   - [ ] API 響應時間正常
   - [ ] 前端載入速度正常
   - [ ] 無明顯性能問題

測試完成後，您就可以安全地部署到生產環境了！