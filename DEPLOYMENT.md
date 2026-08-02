# 部署指南

## 🚀 部署選項

由於應用程式現在直接使用 Firebase，這是一個純靜態網站應用。您可以選擇以下部署方式：

### 1. Firebase Hosting（推薦）

Firebase Hosting 是最適合的部署方式，因為應用程式已經使用 Firebase 服務。

#### 步驟：

1. **安裝 Firebase CLI**
   ```bash
   npm install -g firebase-tools
   ```

2. **登入 Firebase**
   ```bash
   firebase login
   ```

3. **初始化 Firebase Hosting**
   ```bash
   firebase init hosting
   ```
   - 選擇現有的 Firebase 專案
   - 設置公共目錄為當前目錄 `.`
   - 選擇「No」作為單頁應用程式配置
   - 選擇「No」進行自動構建

4. **部署**
   ```bash
   firebase deploy
   ```

### 2. GitHub Pages

#### 步驟：

1. **將代碼推送到 GitHub**

2. **在 GitHub 倉庫中設置 Pages**
   - 進入 Settings > Pages
   - Source 選擇「Deploy from a branch」
   - Branch 選擇「main」或「master」
   - 目錄選擇「/ (root)」
   - 點擊 Save

3. **更新 Firebase 配置**
   - 確保 `firebase-config.js` 中的配置使用您的生產環境 Firebase 專案

### 3. Vercel

#### 步驟：

1. **在 Vercel 創建新專案**
   - 連接您的 GitHub 倉庫
   - 選擇此倉庫

2. **配置構建設置**
   - Framework Preset: Other
   - Build Command: 留空
   - Output Directory: .

3. **部署**
   - 點擊 Deploy

### 4. Netlify

#### 步驟：

1. **在 Netlify 創建新站點**
   - 上傳項目文件夾或連接 GitHub

2. **配置構建設置**
   - Build command: 留空
   - Publish directory: .

3. **部署**
   - 點擊 Deploy site

### 5. Render（當前配置）

如果您想使用 Render，需要使用 render.yaml 配置文件：

#### 前端靜態網站：

```yaml
services:
  - type: web
    name: food-guardian-frontend
    env: static
    buildCommand: echo "No build command needed"
    staticPublishPath: .
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
```

#### 關於後端服務：

**重要說明：** 由於應用程式現在直接使用 Firebase，後端服務是可選的。如果您需要後端服務用於管理功能，可以單獨部署後端：

1. 在 Render 創建 Web Service
2. 根目錄設置為 `backend`
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. 添加環境變數（參考 `backend/.env.example`）

## 🔧 部署前檢查清單

### 1. Firebase 配置
- [ ] 已在 Firebase Console 創建專案
- [ ] 已啟用 Authentication (Email/Password)
- [ ] 已創建 Firestore 資料庫
- [ ] 已設置 Firestore 安全規則
- [ ] 已更新 `firebase-config.js` 中的配置

### 2. 環境變數
- [ ] 生產環境使用正確的 Firebase 配置
- [ ] 如有後端，已設置所有必要環境變數

### 3. 安全設置
- [ ] Firestore 安全規則設置正確
- [ ] 不在前端代碼中暴露敏感信息
- [ ] Firebase API Key 限制設置正確

## 📝 重要注意事項

### Firebase 安全規則（生產環境）

建議使用更嚴格的安全規則：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 用戶只能讀寫自己的文檔
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    
    // 任務記錄 - 用戶只能創建和讀取自己的記錄
    match /task_records/{recordId} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
    }
    
    // 兌換記錄 - 用戶只能創建和讀取自己的記錄
    match /exchange_records/{recordId} {
      allow read: if request.auth != null && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
    }
    
    // 其他集合的規則...
  }
}
```

### API Key 限制

在 Firebase Console 中：
1. 進入項目設置 > API 金鑰
2. 編輯您的 API Key
3. 應用限制設置為您的部署域名
4. API 限制只選擇需要的服務

## 🐛 故障排除

### Render 部署錯誤

**錯誤：** `ENOENT: no such file or directory, open '/opt/render/project/src/package.json'`

**解決方案：**
1. 確保根目錄有 `package.json` 文件（已創建）
2. 如果部署後端，確保 `render.yaml` 正確配置目錄
3. 使用靜態網站服務類型

### Firebase 權限錯誤

**錯誤：** `Missing or insufficient permissions`

**解決方案：**
1. 檢查 Firestore 安全規則
2. 確認用戶已登入
3. 檢查 API Key 限制設置

### CORS 錯誤

**錯誤：** 跨域請求被阻止

**解決方案：**
1. 由於現在使用 Firebase，通常不會有 CORS 問題
2. 如果仍有問題，檢查 Firebase Console 中的已授權域名

## 🎯 推薦部署流程

對於生產環境，推薦使用 Firebase Hosting：

1. **設置 Firebase 專案**（參考 FIREBASE_SETUP.md）
2. **測試本地功能**
3. **部署到 Firebase Hosting**
4. **設置自定義域名**（可選）
5. **配置 Analytics**（可選）

這樣可以確保最佳的性能和安全性，因為應用程式已經完全依賴 Firebase 服務。