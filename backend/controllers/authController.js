/**
 * 註冊 / 登入 / 登出。
 *
 * 註冊分兩種身份（其餘角色由 seed 或管理員建立）：
 *
 *  學生：帳號 + 密碼 + 姓名 + 年級 + 班級 + 座號
 *        → 年級/班級必須對得上 classes 名冊，座號不可重複。
 *
 *  家長：email + 密碼 + 姓名 + 「孩子的年級/班級/座號/帳號」
 *        → **四項全部要對得上同一位學生**才綁定成功。
 *
 * 原版的家長流程有兩個洞，這裡都補掉：
 *  (1) 原本拿「學生帳號」去比對 email 欄位，等於帳號與 email 混用；
 *  (2) 原本把家長填的年級/班級/座號**寫進學生資料**，家長可藉此覆寫學生班級座號。
 *      現在是反過來核對，不一致就拒絕，且永不改寫學生的名冊欄位。
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, admin } = require('../config/firebase');
const { COL, ROLES, SELF_REGISTER_ROLES } = require('../config/schema');

const JWT_SECRET = process.env.JWT_SECRET || 'lunch-leftovers-default-secret-please-change';
const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const norm = (v) => String(v == null ? '' : v).trim();
const key = (v) => norm(v).toLowerCase();

function signToken(user) {
  // 只放識別用的最小資訊；角色與權限一律由伺服器每次從 DB 讀（見 middleware/auth.js）
  return jwt.sign({ uid: user.userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** 回給前端的使用者資料（家長不含幣欄位）。*/
function buildUserResponse(u) {
  const base = {
    userId: u.userId,
    displayName: u.displayName,
    email: u.email || null,
    account: u.account || null,
    role: u.role,
    classId: u.classId || null,
    grade: u.grade || null,
    className: u.className || null,
    seatNo: u.seatNo || null,
  };
  if (u.role === ROLES.PARENT) {
    return { ...base, studentBinding: u.studentBinding || null, boundStudentId: u.boundStudentId || null };
  }
  return { ...base, eCoin: Number(u.eCoin || 0), sCoin: Number(u.sCoin || 0), score: Number(u.score || 0) };
}

const bad = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

/** 依年級 + 班級名稱找班級（名冊必須先由老師/管理員建立）。*/
async function findClass(grade, className) {
  const snap = await db.collection(COL.classes)
    .where('grade', '==', norm(grade))
    .where('name', '==', norm(className))
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** 依帳號找使用者（帳號或 email 皆可）。*/
async function findUserByIdentifier(identifier) {
  const id = key(identifier);
  if (!id) return null;

  const reserved = await db.collection(COL.accountIndex).doc(id).get();
  if (reserved.exists) {
    const userSnap = await db.collection(COL.users).doc(reserved.data().userId).get();
    if (userSnap.exists) return { id: userSnap.id, ...userSnap.data() };
  }
  // 相容舊資料（尚未建立保留表的帳號）
  for (const field of ['account', 'email']) {
    const snap = await db.collection(COL.users).where(field, '==', norm(identifier)).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return null;
}

/**
 * 建立使用者：在同一個 transaction 內「搶占帳號」再寫入，確保帳號唯一。
 *
 * Firestore 沒有唯一鍵，所以用 account_index/{小寫帳號} 當鎖。
 * 自助註冊與管理員建帳號都走這支，唯一性只有一套實作。
 *
 * @throws {Error & {status:409}} 帳號已被使用
 */
async function createUserWithAccount({ userId, account, userData, extraWrites = [] }) {
  await db.runTransaction(async (tx) => {
    const indexRef = db.collection(COL.accountIndex).doc(key(account));
    const existing = await tx.get(indexRef);
    if (existing.exists) {
      const err = new Error('此帳號已被註冊');
      err.status = 409;
      throw err;
    }
    tx.set(indexRef, { userId, role: userData.role, createdAt: serverTime() });
    tx.set(db.collection(COL.users).doc(userId), userData);
    extraWrites.forEach((w) => tx.set(w.ref, w.data, { merge: true }));
  });
  return userId;
}

// ── 註冊 ────────────────────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const role = SELF_REGISTER_ROLES.includes(req.body.role) ? req.body.role : ROLES.STUDENT;
    const displayName = norm(req.body.displayName);
    const password = String(req.body.password || '');
    // 學生以帳號登入、家長以 email 登入；兩者都存進保留表確保唯一
    const account = norm(req.body.account || req.body.email);
    const email = norm(req.body.email) || null;

    if (!displayName || !password || !account) {
      return bad(res, 400, '請填寫姓名、帳號與密碼');
    }
    if (password.length < 6) {
      return bad(res, 400, '密碼至少需要 6 個字元');
    }

    const userId = db.collection(COL.users).doc().id;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let userData;
    let extraWrites = [];

    if (role === ROLES.PARENT) {
      const binding = {
        grade: norm(req.body.studentGrade),
        className: norm(req.body.studentClass),
        seatNo: norm(req.body.studentSeat),
        account: norm(req.body.studentAccount),
      };
      if (!binding.grade || !binding.className || !binding.seatNo || !binding.account) {
        return bad(res, 400, '家長註冊需填寫孩子的年級、班級、座號與帳號');
      }

      const student = await findUserByIdentifier(binding.account);
      if (!student) return bad(res, 404, '查無此學生帳號，請確認孩子的帳號');
      if (student.role !== ROLES.STUDENT && student.role !== ROLES.LUNCH_LEADER) {
        return bad(res, 400, '綁定的帳號必須是學生');
      }

      // 四項全對才算驗證通過；任何一項不符都不透露是哪一項（避免被試出名冊）
      const matched =
        norm(student.grade) === binding.grade &&
        norm(student.className) === binding.className &&
        norm(student.seatNo) === binding.seatNo;
      if (!matched) {
        return bad(res, 400, '學生資料不符（年級、班級、座號需與學生帳號一致）');
      }
      if (student.parentUserId && student.parentUserId !== userId) {
        return bad(res, 409, '此學生已綁定家長帳號');
      }

      userData = {
        userId,
        role: ROLES.PARENT,
        displayName,
        account,
        email,
        passwordHash,
        isActive: true,
        // 家長沒有幣系統：不建立 eCoin/sCoin/score 欄位
        boundStudentId: student.id,
        studentBinding: {
          ...binding,
          studentId: student.id,
          studentName: student.displayName || '',
          classId: student.classId || null,
        },
        schoolId: student.schoolId || null,
        createdAt: serverTime(),
        lastLoginAt: serverTime(),
      };
      // 只在學生身上寫「家長是誰」，不改寫學生的名冊欄位
      extraWrites.push({
        ref: db.collection(COL.users).doc(student.id),
        data: { parentUserId: userId, parentName: displayName },
      });
    } else {
      const grade = norm(req.body.grade || req.body.studentGrade);
      const className = norm(req.body.className || req.body.studentClass);
      const seatNo = norm(req.body.seatNo || req.body.studentSeat);
      if (!grade || !className || !seatNo) {
        return bad(res, 400, '學生註冊需填寫年級、班級與座號');
      }

      const klass = await findClass(grade, className);
      if (!klass) {
        return bad(res, 404, `查無 ${grade} 年 ${className} 班，請確認或聯絡老師建立班級`);
      }

      const seatTaken = await db.collection(COL.users)
        .where('classId', '==', klass.id)
        .where('seatNo', '==', seatNo)
        .limit(1)
        .get();
      if (!seatTaken.empty) {
        return bad(res, 409, '此座號已有人註冊，請確認座號或聯絡老師');
      }

      userData = {
        userId,
        role: ROLES.STUDENT,
        displayName,
        account,
        email,
        passwordHash,
        isActive: true,
        eCoin: 0,
        sCoin: 0,
        score: 0,
        schoolId: klass.schoolId || null,
        classId: klass.id,
        grade,
        className,
        seatNo,
        createdAt: serverTime(),
        lastLoginAt: serverTime(),
      };
    }

    // 帳號唯一性由共用函式保證（與管理員建帳號同一套邏輯）
    try {
      await createUserWithAccount({ userId, account, userData, extraWrites });
    } catch (err) {
      if (err.status === 409) return bad(res, 409, err.message);
      throw err;
    }

    return res.status(201).json({
      success: true,
      userId,
      token: signToken(userData),
      userData: buildUserResponse(userData),
    });
  } catch (error) {
    console.error('註冊失敗:', error);
    return bad(res, 500, error.message || '註冊失敗');
  }
};

// ── 登入 ────────────────────────────────────────────────────────────
const login = async (req, res) => {
  try {
    // 前端欄位沿用 email；學生可直接填帳號
    const identifier = norm(req.body.account || req.body.email);
    const password = String(req.body.password || '');

    if (!identifier || !password) {
      return bad(res, 400, '請填寫帳號與密碼');
    }

    const user = await findUserByIdentifier(identifier);
    // 帳號不存在與密碼錯誤回同一句，避免被枚舉帳號
    if (!user || !user.passwordHash) {
      return bad(res, 401, '帳號或密碼錯誤');
    }
    if (user.isActive === false) {
      return bad(res, 403, '此帳號已被停用');
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return bad(res, 401, '帳號或密碼錯誤');
    }

    await db.collection(COL.users).doc(user.id).update({ lastLoginAt: serverTime() });

    return res.status(200).json({
      success: true,
      message: '登入成功',
      token: signToken({ userId: user.id }),
      userData: buildUserResponse({ ...user, userId: user.id }),
    });
  } catch (error) {
    console.error('登入失敗:', error);
    return bad(res, 500, error.message || '登入失敗');
  }
};

const logout = async (req, res) => res.status(200).json({ success: true, message: '登出成功' });

module.exports = {
  register, login, logout,
  buildUserResponse, findUserByIdentifier, findClass,
  createUserWithAccount, norm, key, serverTime,
};

/**
 * POST /auth/verify-student —— 家長註冊前的友善驗證（不建立任何資料）。
 *
 * 讓家長先按「驗證孩子資料」確認四項對不對，而不是填完整張表才被退回。
 * 回傳的姓名經過遮罩（王○明），足以讓家長確認是自己的孩子，
 * 又不會讓人拿別人的帳號把全名試出來。
 */
const verifyStudent = async (req, res) => {
  try {
    const grade = norm(req.body.studentGrade);
    const className = norm(req.body.studentClass);
    const seatNo = norm(req.body.studentSeat);
    const account = norm(req.body.studentAccount);

    if (!grade || !className || !seatNo || !account) {
      return bad(res, 400, '請先填寫孩子的年級、班級、座號與帳號');
    }

    const student = await findUserByIdentifier(account);
    const matched =
      student &&
      (student.role === ROLES.STUDENT || student.role === ROLES.LUNCH_LEADER) &&
      norm(student.grade) === grade &&
      norm(student.className) === className &&
      norm(student.seatNo) === seatNo;

    if (!matched) {
      return res.status(200).json({
        success: true,
        verified: false,
        message: '資料不符，請再確認孩子的年級、班級、座號與帳號',
      });
    }
    if (student.parentUserId) {
      return res.status(200).json({
        success: true,
        verified: false,
        alreadyBound: true,
        message: '這位學生已經綁定過家長帳號了',
      });
    }

    const name = String(student.displayName || '');
    const masked = name.length <= 2 ? name : name[0] + '○'.repeat(name.length - 2) + name[name.length - 1];
    return res.status(200).json({
      success: true,
      verified: true,
      maskedName: masked,
      className: student.className,
      message: `找到 ${grade} 年 ${className} 班 ${seatNo} 號 ${masked}，可以完成註冊`,
    });
  } catch (error) {
    console.error('驗證學生資料失敗:', error);
    return bad(res, 500, error.message || '驗證失敗');
  }
};

module.exports.verifyStudent = verifyStudent;
