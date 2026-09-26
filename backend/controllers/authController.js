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

function normalizeRole(role) {
  return role === 'parent' ? 'parent' : 'student';
}

function buildUserResponse(userData) {
  const response = {
    userId: userData.userId,
    displayName: userData.displayName,
    email: userData.email,
    eCoin: userData.eCoin || 0,
    sCoin: userData.sCoin || 0,
    score: userData.score || 0,
    role: userData.role
  };

  if (userData.studentBinding) {
    response.studentBinding = userData.studentBinding;
  }

  return response;
}

// 註冊新使用者
const register = async (req, res) => {
  try {
    const {
      email,
      password,
      displayName,
      role,
      schoolId,
      classId,
      studentGrade,
      studentClass,
      studentSeat,
      studentAccount
    } = req.body;
    const normalizedRole = normalizeRole(role);

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

    if (normalizedRole === 'parent') {
      if (!studentGrade || !studentClass || !studentSeat || !studentAccount) {
        return res.status(400).json({
          success: false,
          message: '家長註冊需填寫學生年級、班級、座號與帳號'
        });
      }
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
    const userRole = normalizedRole;
    const studentBinding = userRole === 'parent'
      ? {
          grade: String(studentGrade).trim(),
          className: String(studentClass).trim(),
          seatNo: String(studentSeat).trim(),
          account: String(studentAccount).trim()
        }
      : null;

    const userData = {
      userId,
      email,
      displayName,
      passwordHash,
      eCoin: 0,
      sCoin: 0,
      score: 0,
      role: userRole,
      isActive: true,
      schoolId: schoolId || null,
      classId: classId || null,
      createdAt: now,
      lastLoginAt: now,
      studentBinding
    };

    const userRef = db.collection('users').doc(userId);

    if (userRole === 'parent') {
      const studentSnapshot = await db.collection('users')
        .where('email', '==', studentBinding.account)
        .limit(1)
        .get();

      if (studentSnapshot.empty) {
        return res.status(404).json({
          success: false,
          message: '找不到對應的學生帳號'
        });
      }

      const studentDoc = studentSnapshot.docs[0];
      const studentData = studentDoc.data();

      if (studentData.role !== 'student') {
        return res.status(400).json({
          success: false,
          message: '綁定帳號必須是學生身份'
        });
      }

      if (studentData.parentUserId && studentData.parentUserId !== userId) {
        return res.status(400).json({
          success: false,
          message: '此學生已綁定家長帳號'
        });
      }

      const batch = db.batch();
      batch.set(userRef, userData);
      batch.set(studentDoc.ref, {
        studentGrade: studentBinding.grade,
        studentClass: studentBinding.className,
        studentSeat: studentBinding.seatNo,
        parentUserId: userId
      }, { merge: true });
      await batch.commit();
    } else {
      await userRef.set(userData);
    }

    const token = signToken(userData);

    res.status(201).json({
      success: true,
      userId,
      token,
      userData: buildUserResponse(userData)
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
      userData: buildUserResponse(userData)
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
