# Firebase 設置說明

## 1. 建立 Firebase 專案

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 點擊「新增專案」
3. 輸入專案名稱（例如：food-guardian）
4. 按照步驟完成專案建立

## 2. 啟用 Authentication

1. 在 Firebase Console 中，選擇「Authentication」
2. 點擊「開始使用」
3. 選擇「登入方式」標籤
4. 啟用「Email/密碼」登入方式
5. 點擊「儲存」

## 3. 建立 Firestore 資料庫

1. 在 Firebase Console 中，選擇「Firestore Database」
2. 點擊「建立資料庫」
3. 選擇生產模式或測試模式（建議先用測試模式）
4. 選擇資料庫位置（建議選擇離使用者最近的區域）
5. 點擊「建立」

## 4. 獲取 Firebase 配置

1. 在 Firebase Console 中，點擊專案設置（齒輪圖標）
2. 選擇「一般」標籤
3. 向下捲動到「您的應用程式」區域
4. 選擇「Web」應用程式
5. 輸入應用程式名稱（例如：Food Guardian）
6. 不勾選「Firebase Hosting」
7. 點擊「註冊應用程式」
8. 複製 Firebase 配置代碼

## 5. 更新 firebase-config.js

將複製的配置替換到 `firebase-config.js` 文件中：

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

## 6. 設置 Firestore 安全規則

在 Firebase Console 的 Firestore 規則中，設置以下規則（開發階段）：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## 7. 測試登入流程

1. 在瀏覽器中打開 `index.html`
2. 點擊「註冊」標籤
3. 填寫註冊表單：
   - 顯示名稱：測試用戶
   - Email：test@example.com
   - 密碼：123456
   - 確認密碼：123456
4. 點擊「註冊」按鈕
5. 檢查是否成功註冊並自動登入
6. 測試登出功能
7. 測試使用 Email 和密碼登入

## 8. 驗證 Firestore 資料

1. 在 Firebase Console 中查看 Firestore 資料庫
2. 檢查 `users` 集合中是否創建了用戶文檔
3. 檢查用戶資料是否包含：
   - userId
   - email
   - displayName
   - eCoin
   - sCoin
   - score
   - createdAt
   - lastLoginAt

## 9. 測試功能

測試以下功能是否正常工作：

1. **任務系統**
   - 點擊「完成午餐光碟行動」
   - 檢查 E幣、S幣、積分是否正確增加
   - 檢查 24 小時冷卻是否生效

2. **兌換系統**
   - 測試 E幣兌換（環保杯、環保餐具）
   - 測試 S幣兌換（文具禮包）
   - 檢查幣值是否正確扣除

3. **剩食獎勵**
   - 填寫剩食分析資料
   - 測試領取獎勵功能
   - 檢查冷卻時間

4. **問卷系統**
   - 填寫最喜歡/最不喜歡的菜色
   - 檢查問卷提交功能

## 故障排除

### Firebase 未正確載入
- 檢查瀏覽器控制台是否有錯誤
- 確認 Firebase SDK 版本正確
- 檢查網絡連接

### 註冊失敗
- 檢查 Email 格式是否正確
- 檢查密碼是否至少 6 個字元
- 檢查 Firebase Authentication 是否已啟用 Email/密碼登入

### Firestore 權限錯誤
- 檢查 Firestore 安全規則設置
- 確認用戶已正確登入

### 資料未保存
- 檢查 Firestore 資料庫是否已建立
- 檢查網絡連接
- 查看瀏覽器控制台錯誤信息