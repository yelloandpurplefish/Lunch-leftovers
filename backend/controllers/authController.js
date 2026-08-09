const { admin, auth, db } = require('../config/firebase');

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

// 驗證登入 Token 並回傳使用者資料
const login = async (req, res) => {
  try {
    const { uid, email } = req.user;

    // 獲取使用者資料
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '使用者不存在'
      });
    }

    // 更新最後登入時間
    await db.collection('users').doc(uid).update({
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userData = userDoc.data();

    res.status(200).json({
      success: true,
      message: '登入驗證成功',
      user: {
        uid,
        email,
        displayName: userData.displayName,
        eCoin: userData.eCoin,
        sCoin: userData.sCoin,
        score: userData.score,
        role: userData.role
      }
    });
  } catch (error) {
    console.error('登入驗證失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '登入驗證失敗'
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
