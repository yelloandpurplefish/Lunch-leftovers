/**
 * 驗證與授權。
 *
 * 與原版的差異（安全性）：
 *  1. **每次請求都從資料庫讀使用者**，角色與啟用狀態以 DB 為準。
 *     原版直接信任 JWT 裡的 role，改角色或停權後舊 token 仍然暢行無阻。
 *  2. `isActive=false` 一律擋下。
 *  3. 正式環境沒設 JWT_SECRET 直接拒絕啟動（原本會退回寫死的預設值，等於無密鑰）。
 *  4. 統一用 `requireRole()` 描述權限，路由一眼看得出誰能打。
 */
const jwt = require('jsonwebtoken');
const { db } = require('../config/firebase');
const { COL, ROLES } = require('../config/schema');

const JWT_SECRET = process.env.JWT_SECRET || 'lunch-leftovers-default-secret-please-change';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET) {
  if (IS_PROD) {
    throw new Error('正式環境必須設定 JWT_SECRET（目前未設定，拒絕啟動）');
  }
  console.warn('⚠️  JWT_SECRET 未設定，使用開發預設值。部署前務必設定。');
}

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/**
 * 驗證 token → 載入使用者。成功後 req.user 為：
 * { uid, email, account, displayName, role, classId, schoolId, grade, className, seatNo, parentUserId }
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return fail(res, 401, '未提供認證 Token');
    }

    let decoded;
    try {
      decoded = jwt.verify(header.slice(7).trim(), JWT_SECRET);
    } catch (err) {
      return fail(res, 401, 'Token 無效或已過期');
    }

    const snap = await db.collection(COL.users).doc(decoded.uid).get();
    if (!snap.exists) {
      return fail(res, 401, '使用者不存在，請重新登入');
    }
    const u = snap.data();
    if (u.isActive === false) {
      return fail(res, 403, '此帳號已被停用');
    }

    req.user = {
      uid: snap.id,
      email: u.email || null,
      account: u.account || null,
      displayName: u.displayName || '',
      role: u.role,                 // ← 以資料庫為準，不用 token 裡的
      classId: u.classId || null,
      schoolId: u.schoolId || null,
      grade: u.grade || null,
      className: u.className || null,
      seatNo: u.seatNo || null,
      parentUserId: u.parentUserId || null,
      boundStudentId: u.boundStudentId || null,
    };
    req.userDoc = u;
    return next();
  } catch (error) {
    console.error('驗證失敗:', error);
    return fail(res, 500, '伺服器錯誤');
  }
}

/** 限定角色。管理員永遠通行。*/
function requireRole(...roles) {
  const allowed = new Set([...roles, ROLES.ADMIN]);
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, '未登入');
    if (!allowed.has(req.user.role)) {
      return fail(res, 403, '權限不足');
    }
    return next();
  };
}

/** 必須屬於某個班級（紀錄、勾選、班級排行都需要）。*/
function requireClass(req, res, next) {
  if (!req.user) return fail(res, 401, '未登入');
  if (!req.user.classId) {
    return fail(res, 400, '此帳號尚未編入班級，請聯絡老師');
  }
  return next();
}

// ── 向後相容：原有路由仍使用這些名稱 ────────────────────────────────
const verifyFirebaseToken = authenticate;
const verifyAdmin = requireRole(ROLES.ADMIN);
const verifyTeacherOrAdmin = requireRole(ROLES.TEACHER);

module.exports = {
  authenticate,
  requireRole,
  requireClass,
  ROLES,
  // 相容別名
  verifyFirebaseToken,
  verifyAdmin,
  verifyTeacherOrAdmin,
};
