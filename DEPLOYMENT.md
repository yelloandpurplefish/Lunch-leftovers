# 部署指南

## 🚀 部署架構

這是一個**動態網站**，包含：
- **前端：** HTML5 + JavaScript + Firebase Authentication
- **後端：** Node.js + Express + Firebase Admin SDK
- **資料庫：** Firebase Firestore

前端使用 Firebase SDK 進行身份驗證，通過後端 API 操作 Firestore 以保持安全性和權限控制。

## 📋 部署選項

### 1. Render（推薦）

使用提供的 `render.yaml` 配置文件進行一鍵部署。

#### 步驟：

1. **推送到 GitHub**
   ```bash
   git add .
   git commit -m "準備部署"
   git push origin main
   ```

2. **在 Render 創建 Web Service**
   - 連接您的 GitHub 倉庫
   - 選擇此倉庫
   - Render 會自動檢測 `render.yaml` 配置

3. **設置環境變數**
   - `FIREBASE_DATABASE_URL`: 您的 Firebase 資料庫 URL
   - `NODE_ENV`: production
   - `PORT`: 3000

4. **部署**
   - 點擊 Deploy
   - Render 會自動構建和啟動

#### 關於 Firebase Service Account Key：

在 Render 環境變數中添加：
- 下載 Firebase Service Account Key JSON
- 將 JSON 內容轉換為單行字符串
- 設置環境變數 `FIREBASE_SERVICE_ACCOUNT_KEY`

### 2. 手動部署

#### 本地測試：

```bash
# 安裝後端依賴
cd backend
npm install

# 設置環境變數
cp .env.example .env
# 編輯 .env 填入 Firebase 配置

# 啟動開發服務器
npm run dev
```

#### 伺服器部署：

```bash
# 安裝依賴
cd backend
npm install --production

# 設置環境變數
export FIREBASE_DATABASE_URL="your-firebase-url"
export NODE_ENV="production"
export PORT="3000"

# 使用 PM2 啟動
pm2 start server.js --name food-guardian
pm2 save
pm2 startup
```

### 3. Docker 部署

創建 `Dockerfile`：

```dockerfile
FROM node:18-alpine

WORKDIR /app

# 複製後端依賴文件
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# 複製後端代碼
COPY backend/ ./backend/

# 複製前端文件
COPY index.html firebase-config.js app.js style.css ./

# 暴露端口
EXPOSE 3000

# 啟動服務器
CMD ["node", "backend/server.js"]
```

構建和運行：

```bash
docker build -t food-guardian .
docker run -p 3000:3000 \
  -e FIREBASE_DATABASE_URL="your-firebase-url" \
  -e NODE_ENV="production" \
  food-guardian
```

## 🔧 部署前檢查清單

### 1. Firebase 配置
- [ ] 已在 Firebase Console 創建專案
- [ ] 已啟用 Authentication (Email/Password)
- [ ] 已創建 Firestore 資料庫
- [ ] 已下載 Service Account Key
- [ ] 已更新 `firebase-config.js` 中的配置

### 2. 後端配置
- [ ] 已設置 `backend/.env` 環境變數
- [ ] 已安裝後端依賴 (`npm install`)
- [ ] Service Account Key 安全存放

### 3. 安全設置
- [ ] Firestore 安全規則設置正確
- [ ] API Key 限制設置正確
- [ ] CORS 設置正確
- [ ] 敏感信息未提交到 Git

## 📝 環境變數說明

### 前端配置 (`firebase-config.js`)
- `firebaseConfig`: Firebase 專案配置
- `API_BASE_URL`: 後端 API 地址（自動檢測）

### 後端配置 (`backend/.env`)
```env
# 伺服器配置
PORT=3000
NODE_ENV=production

# Firebase Admin SDK 配置
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
```

## �️ 安全設置

### Firestore 安全規則

由於前端通過後端 API 操作，可以設置較寬鬆的規則：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 只允許後端服務帳戶訪問
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### API Key 限制

1. 進入 Firebase Console > 項目設置 > API 金鑰
2. 編輯您的 API Key
3. 應用限制設置為您的部署域名
4. IP 限制設置為伺服器 IP（如適用）

## 🐛 故障排除

### 連接後端失敗

**問題：** 前端無法連接到後端 API

**解決方案：**
1. 檢查 `firebase-config.js` 中的 `API_BASE_URL`
2. 確認後端服務器正在運行
3. 檢查 CORS 設置
4. 查看瀏覽器控制台錯誤

### Firebase 認證失敗

**問題：** 無法登入或註冊

**解決方案：**
1. 檢查 Firebase Authentication 是否已啟用 Email/Password
2. 確認 Firebase 配置正確
3. 檢查網絡連接
4. 查看瀏覽器控制台錯誤

### Firestore 權限錯誤

**問題：** 後端無法訪問 Firestore

**解決方案：**
1. 檢查 Service Account Key 是否正確
2. 確認 Firestore 安全規則
3. 檢查環境變數設置
4. 查看後端日志

### Render 部署失敗

**問題：** Render 部署時出現錯誤

**解決方案：**
1. 檢查 `render.yaml` 配置
2. 確認 `package.json` 存在
3. 檢查環境變數設置
4. 查看 Render 構建日志

## 🎯 推薦部署流程

對於生產環境，推薦使用 Render：

1. **設置 Firebase 專案**（參考 FIREBASE_SETUP.md）
2. **配置後端環境變數**
3. **推送到 GitHub**
4. **在 Render 創建 Web Service**
5. **設置環境變數**
6. **部署並測試**

這樣可以確保：
- 前後端在同一域名下
- 自動 HTTPS
- 簡單的部署流程
- 良好的性能