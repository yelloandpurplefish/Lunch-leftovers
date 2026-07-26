const { auth, db } = require('../config/firebase');
const { verifyFirebaseToken } = require('../middleware/auth');

// 註冊新使用者
const register = async (req, res) => {
  try {
    const { email, password, displayName, schoolId, classId } = req.body;

    // 驗證輸入
    if (!email || !password || !displayName) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有必填欄位'
      });
    }

    // 創建 Firebase 使用者
    const userRecord = await auth.createUser({
      email,
      password,
      displayName
    });

    // 建立使用者文件
    const userData = {
      userId: userRecord.uid,
      email,
      displayName,
      eCoin: 0,
      sCoin: 0,
      score: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      schoolId: schoolId || null,
      classId: classId || null,
      role: 'student',
      isActive: true
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // 產生自定義 Token
    const customToken = await auth.createCustomToken(userRecord.uid);

    res.status(201).json({
      success: true,
      userId: userRecord.uid,
      token: customToken,
      userData: {
        displayName: userData.displayName,
        eCoin: userData.eCoin,
        sCoin: userData.sCoin,
        score: userData.score
      }
    });
  } catch (error) {
    console.error('註冊失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '註冊失敗'
    });
  }
};

// 登入
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: '請提供 Email 和密碼'
      });
    }

    // Firebase Auth 登入由前端處理，後端只驗證 Token
    // 這裡提供一個簡化的登入介面，實際應該由前端使用 Firebase SDK 登入後獲取 Token
    res.status(200).json({
      success: true,
      message: '請使用 Firebase SDK 進行登入，然後使用 ID Token 呼叫 API'
    });
  } catch (error) {
    console.error('登入失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '登入失敗'
    });
  }
};

// 登出
const logout = async (req, res) => {
  try {
    // Firebase Auth 登出由前端處理
    res.status(200).json({
      success: true,
      message: '登出成功'
    });
  } catch (error) {
    console.error('登出失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '登出失敗'
    });
  }
};

module.exports = { register, login, logout };
