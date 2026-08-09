# 測試指南

## 🧪 測試環境設置

### 1. 安裝依賴

```bash
# 安裝後端依賴
cd backend
npm install

# 或使用根目錄腳本
npm run install-backend
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
```

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
cd backend
npm run dev
```

### 生產模式

```bash
cd backend
npm start
```

服務器將在 `http://localhost:3000` 啟動

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