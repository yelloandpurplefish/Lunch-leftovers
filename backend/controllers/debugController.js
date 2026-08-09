const { admin, auth, db } = require('../config/firebase');

// 測試 Firebase Admin SDK 連接
const testFirebase = async (req, res) => {
  try {
    if (!admin || !auth || !db) {
      return res.status(500).json({
        success: false,
        message: 'Firebase Admin SDK 未初始化',
        details: '請檢查 Service Account Key 和 FIREBASE_DATABASE_URL 環境變數'
      });
    }

    // 測試 Auth 連接
    let authTest = { success: true, message: 'Auth 連接正常' };
    try {
      await auth.listUsers(1);
    } catch (error) {
      authTest = { success: false, message: 'Auth 連接失敗', error: error.message };
    }

    // 測試 Firestore 連接
    let firestoreTest = { success: true, message: 'Firestore 連接正常' };
    try {
      const testDoc = await db.collection('users').limit(1).get();
      firestoreTest.userCount = testDoc.size;
    } catch (error) {
      firestoreTest = { success: false, message: 'Firestore 連接失敗', error: error.message };
    }

    res.status(200).json({
      success: authTest.success && firestoreTest.success,
      message: 'Firebase 連接測試完成',
      auth: authTest,
      firestore: firestoreTest,
      projectId: admin.app ? admin.app().options.projectId : 'unknown'
    });
  } catch (error) {
    console.error('Firebase 測試失敗:', error);
    res.status(500).json({
      success: false,
      message: 'Firebase 測試失敗',
      error: error.message
    });
  }
};

// 創建測試帳號（僅限開發環境）
const createTestUser = async (req, res) => {
  try {
    // 檢查是否為開發環境
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        message: '此端點僅限開發環境使用'
      });
    }

    const { email, displayName, role = 'student', password } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json({
        success: false,
        message: '請提供 email、password 和 displayName'
      });
    }

    // 創建 Firebase Authentication 用戶
    const userRecord = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: true
    });

    // 創建 Firestore 用戶資料
    await db.collection('users').doc(userRecord.uid).set({
      userId: userRecord.uid,
      email,
      displayName,
      eCoin: 100,
      sCoin: 50,
      score: 1000,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      role,
      isActive: true
    });

    res.status(201).json({
      success: true,
      message: '測試用戶創建成功',
      user: {
        uid: userRecord.uid,
        email,
        displayName,
        role
      }
    });
  } catch (error) {
    console.error('創建測試用戶失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '創建測試用戶失敗'
    });
  }
};

module.exports = { testFirebase, createTestUser };