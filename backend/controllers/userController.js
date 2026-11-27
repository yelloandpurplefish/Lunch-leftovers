const { db, admin } = require('../config/firebase');
const { COL, COIN_HOLDER_ROLES } = require('../config/schema');
const { isLunchLeader } = require('../middleware/auth');

/**
 * GET /api/user/profile — 自己的資料。
 *
 * isLunchLeader 每次都由班級名冊判斷（午餐長是附加在學生身上的身分，不是角色），
 * 前端據此決定要不要顯示「午餐長專區」。
 *
 * 使用者資料由 authenticate 讀過一次（req.userDoc），這裡不再重讀。
 */
const getProfile = async (req, res) => {
  try {
    await db.collection(COL.users).doc(req.user.uid).update({
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const u = req.userDoc;
    const holdsCoins = COIN_HOLDER_ROLES.includes(u.role);
    return res.status(200).json({
      success: true,
      userData: {
        userId: req.user.uid,
        displayName: u.displayName,
        email: u.email || null,
        account: u.account || null,
        role: u.role,
        schoolId: u.schoolId || null,
        classId: u.classId || null,
        grade: u.grade || null,
        className: u.className || null,
        seatNo: u.seatNo || null,
        esgCoin: holdsCoins ? Number(u.esgCoin || 0) : null,
        isLunchLeader: await isLunchLeader(req.user),
        boundStudentId: u.boundStudentId || null,
      },
    });
  } catch (error) {
    console.error('獲取使用者資料失敗:', error);
    return res.status(500).json({ success: false, message: error.message || '獲取使用者資料失敗' });
  }
};

module.exports = { getProfile };
