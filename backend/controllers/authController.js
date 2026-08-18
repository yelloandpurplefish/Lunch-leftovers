const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, admin } = require('../config/firebase');

const JWT_SECRET = process.env.JWT_SECRET || 'lunch-leftovers-default-secret-please-change';

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET 未設定，使用預設值。請在 .env 或 Render 環境變數中設置 JWT_SECRET。');
}

// 產生 JWT
function signToken(user) {
  return jwt.sign(
    { uid: user.userId, email: user.email, displayName: user.displayName, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// 註冊新使用者
const register = async (req, res) => {
  try {
    const { email, password, displayName, schoolId, classId } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json({
        success: false,
        message: '請填寫所有必填欄位'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: '密碼至少需要 6 個字元'
      });
    }

    // 檢查 Email 是否已註冊
    const existing = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({
        success: false,
        message: '此 Email 已被註冊'
      });
    }

    // 建立使用者
    const userId = db.collection('users').doc().id;
    const passwordHash = await bcrypt.hash(password, 10);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const userData = {
      userId,
      email,
      displayName,
      passwordHash,
      eCoin: 0,
      sCoin: 0,
      gCoin: 0,
      score: 0,
      role: 'student',
      isActive: true,
      schoolId: schoolId || null,
      classId: classId || null,
      createdAt: now,
      lastLoginAt: now
    };

    await db.collection('users').doc(userId).set(userData);

    const token = signToken(userData);

    res.status(201).json({
      success: true,
      userId,
      token,
      userData: {
        userId,
        displayName,
        email,
        eCoin: 0,
        sCoin: 0,
        gCoin: 0,
        score: 0,
        role: 'student'
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
        message: '請填寫所有欄位'
      });
    }

    const userSnapshot = await db.collection('users').where('email', '==', email).limit(1).get();

    if (userSnapshot.empty) {
      return res.status(401).json({
        success: false,
        message: '找不到此帳號'
      });
    }

    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();

    if (!userData.isActive) {
      return res.status(403).json({
        success: false,
        message: '此帳號已被停用'
      });
    }

    const isMatch = await bcrypt.compare(password, userData.passwordHash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: '密碼錯誤'
      });
    }

    // 更新最後登入時間
    await userDoc.ref.update({
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const token = signToken(userData);

    res.status(200).json({
      success: true,
      message: '登入成功',
      token,
      userData: {
        userId: userData.userId,
        displayName: userData.displayName,
        email: userData.email,
        eCoin: userData.eCoin || 0,
        sCoin: userData.sCoin || 0,
        gCoin: userData.gCoin || 0,
        score: userData.score || 0,
        role: userData.role
      }
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
  res.status(200).json({
    success: true,
    message: '登出成功'
  });
};

module.exports = { register, login, logout };
