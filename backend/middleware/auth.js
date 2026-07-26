const jwt = require('jsonwebtoken');
const { auth } = require('../config/firebase');

// 驗證 Firebase Token 的中介軟體
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: '未提供認證 Token' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    // 驗證 Firebase ID Token
    const decodedToken = await auth.verifyIdToken(token);
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };
    
    next();
  } catch (error) {
    console.error('Token 驗證失敗:', error);
    return res.status(401).json({ 
      success: false, 
      message: 'Token 無效或已過期' 
    });
  }
};

// 驗證管理員權限的中介軟體
const verifyAdmin = async (req, res, next) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: '使用者不存在' 
      });
    }

    const userData = userDoc.data();
    
    if (userData.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: '權限不足' 
      });
    }

    req.user.role = userData.role;
    next();
  } catch (error) {
    console.error('權限驗證失敗:', error);
    return res.status(500).json({ 
      success: false, 
      message: '伺服器錯誤' 
    });
  }
};

module.exports = { verifyFirebaseToken, verifyAdmin };
