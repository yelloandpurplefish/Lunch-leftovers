// ============================================================
// 測試帳號建立腳本
// 用途：建立開發人員與測試人員帳號
// 警告：此腳本僅供開發/測試使用，請勿用於生產環境
// ============================================================

require('dotenv').config({ path: '../backend/.env' });

const { auth, db } = require('../backend/config/firebase');

// 測試帳號設定
const TEST_USERS = [
  {
    email: 'dev@example.com',
    displayName: '開發人員',
    role: 'admin',
    eCoin: 1000,
    sCoin: 500,
    score: 10000
  },
  {
    email: 'teacher@example.com',
    displayName: '測試老師',
    role: 'teacher',
    eCoin: 500,
    sCoin: 300,
    score: 5000
  },
  {
    email: 'student1@example.com',
    displayName: '測試學生1',
    role: 'student',
    eCoin: 100,
    sCoin: 50,
    score: 1000
  },
  {
    email: 'student2@example.com',
    displayName: '測試學生2',
    role: 'student',
    eCoin: 100,
    sCoin: 50,
    score: 1000
  }
];

// 預設密碼，建議透過環境變數設定
const DEFAULT_PASSWORD = process.env.TEST_USER_PASSWORD || 'Test@123456';

async function createTestUser(userInfo) {
  try {
    // 檢查用戶是否已存在
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(userInfo.email);
      console.log(`⏭️ 用戶已存在: ${userInfo.email}，跳過創建`);
      return {
        email: userInfo.email,
        uid: userRecord.uid,
        password: DEFAULT_PASSWORD,
        status: 'exists',
        note: '已存在的用戶，密碼可能不是上面顯示的預設密碼'
      };
    } catch (error) {
      // 用戶不存在，繼續創建
    }

    // 創建 Firebase Authentication 用戶
    userRecord = await auth.createUser({
      email: userInfo.email,
      password: DEFAULT_PASSWORD,
      displayName: userInfo.displayName,
      emailVerified: true
    });

    // 創建 Firestore 用戶資料
    await db.collection('users').doc(userRecord.uid).set({
      userId: userRecord.uid,
      email: userInfo.email,
      displayName: userInfo.displayName,
      eCoin: userInfo.eCoin,
      sCoin: userInfo.sCoin,
      score: userInfo.score,
      createdAt: new Date(),
      lastLoginAt: new Date(),
      role: userInfo.role,
      isActive: true
    });

    console.log(`✅ 創建成功: ${userInfo.email} (UID: ${userRecord.uid})`);
    
    return {
      email: userInfo.email,
      uid: userRecord.uid,
      password: DEFAULT_PASSWORD,
      status: 'created'
    };
  } catch (error) {
    console.error(`❌ 創建失敗 ${userInfo.email}:`, error.message);
    return {
      email: userInfo.email,
      password: DEFAULT_PASSWORD,
      status: 'failed',
      error: error.message
    };
  }
}

async function main() {
  console.log('🚀 開始建立測試帳號...\n');
  console.log('⚠️  警告：此腳本僅供開發/測試使用\n');

  if (auth === null || db === null) {
    console.error('❌ Firebase Admin SDK 未初始化，請檢查環境變數和 Service Account Key');
    console.error('請確認 backend/.env 或環境變數已正確設置');
    process.exit(1);
  }

  console.log('✅ Firebase Admin SDK 連接成功\n');

  const results = [];
  for (const userInfo of TEST_USERS) {
    const result = await createTestUser(userInfo);
    results.push(result);
  }

  console.log('\n📋 測試帳號清單：');
  console.log('================================================');
  results.forEach((result) => {
    console.log(`Email:    ${result.email}`);
    console.log(`Password: ${result.password}`);
    console.log(`狀態:     ${result.status}`);
    if (result.error) console.log(`錯誤:     ${result.error}`);
    console.log('------------------------------------------------');
  });
  console.log('================================================\n');

  console.log('🔐 安全提醒：');
  console.log('1. 請勿將此密碼用於生產環境');
  console.log('2. 建議部署前刪除或停用這些測試帳號');
  console.log('3. 可透過 TEST_USER_PASSWORD 環境變數自訂密碼');
  console.log('4. 此腳本建立的資料會寫入 Firebase 和 Firestore\n');
}

main()
  .then(() => {
    console.log('✨ 測試帳號建立完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ 腳本執行失敗:', error);
    process.exit(1);
  });