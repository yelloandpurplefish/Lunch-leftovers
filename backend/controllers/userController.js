const { db, admin } = require('../config/firebase');

// 獲取使用者資料
const getProfile = async (req, res) => {
  try {
    // 更新最後登入時間
    await db.collection('users').doc(req.user.uid).update({
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userDoc = await db.collection('users').doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '使用者不存在'
      });
    }

    const userData = userDoc.data();

    res.status(200).json({
      success: true,
      userData: {
        userId: userData.userId,
        displayName: userData.displayName,
        email: userData.email,
        eCoin: userData.eCoin,
        sCoin: userData.sCoin,
        score: userData.score,
        createdAt: userData.createdAt,
        lastLoginAt: userData.lastLoginAt,
        schoolId: userData.schoolId,
        classId: userData.classId,
        role: userData.role,
        studentBinding: userData.studentBinding || null,
        parentUserId: userData.parentUserId || null,
        studentGrade: userData.studentGrade || null,
        studentClass: userData.studentClass || null,
        studentSeat: userData.studentSeat || null
      }
    });
  } catch (error) {
    console.error('獲取使用者資料失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取使用者資料失敗'
    });
  }
};

// 更新使用者資料
const updateProfile = async (req, res) => {
  try {
    const { displayName, schoolId, classId, studentGrade, studentClass, studentSeat } = req.body;
    const updateData = {};

    if (displayName) updateData.displayName = displayName;
    if (schoolId !== undefined) updateData.schoolId = schoolId;
    if (classId !== undefined) updateData.classId = classId;
    if (studentGrade !== undefined) updateData.studentGrade = studentGrade;
    if (studentClass !== undefined) updateData.studentClass = studentClass;
    if (studentSeat !== undefined) updateData.studentSeat = studentSeat;

    await db.collection('users').doc(req.user.uid).update(updateData);

    res.status(200).json({
      success: true,
      message: '資料更新成功'
    });
  } catch (error) {
    console.error('更新使用者資料失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '更新使用者資料失敗'
    });
  }
};

// 家長簽到
const parentSignIn = async (req, res) => {
  try {
    if (req.user.role !== 'parent') {
      return res.status(403).json({
        success: false,
        message: '僅家長身份可簽到'
      });
    }

    const parentId = req.user.uid;
    const userDoc = await db.collection('users').doc(parentId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: '家長資料不存在'
      });
    }

    const userData = userDoc.data();

    await db.collection('parent_sign_ins').add({
      parentId,
      parentName: userData.displayName,
      parentEmail: userData.email,
      studentBinding: userData.studentBinding || null,
      signedInAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({
      success: true,
      message: '家長簽到成功',
      parentName: userData.displayName,
      studentBinding: userData.studentBinding || null
    });
  } catch (error) {
    console.error('家長簽到失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '家長簽到失敗'
    });
  }
};

// 更新最後登入時間
const updateLastLogin = async (req, res) => {
  try {
    await db.collection('users').doc(req.user.uid).update({
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({
      success: true
    });
  } catch (error) {
    console.error('更新登入時間失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '更新登入時間失敗'
    });
  }
};

module.exports = { getProfile, updateProfile, updateLastLogin, parentSignIn };
