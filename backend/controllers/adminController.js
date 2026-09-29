/**
 * 管理員 / 開發者專區：手動維護名冊。
 *
 * 學生可以自助註冊，但**前提是班級已經存在**；老師、午餐長、管理員帳號
 * 也不該讓人自行註冊。這些「開學前要先建好」與「臨時要補資料」的情況，
 * 全部走這裡：
 *
 *   班級：新增 / 修改（年級、班名、人數）、指定導師與午餐長
 *   帳號：新增（學生 / 午餐長 / 老師 / 管理員）、改角色、改班級座號、
 *         停用啟用、重設密碼
 *
 * 全部端點都要 admin 角色（middleware/auth.js 的 requireRole 會讓 admin 通行）。
 * 所有寫入都會記錄 `updatedBy`，事後查得出是誰改的。
 */
const bcrypt = require('bcryptjs');
const { db, admin } = require('../config/firebase');
const {
  COL, ROLES, ALL_ROLES, COIN_HOLDER_ROLES,
} = require('../config/schema');
const { createUserWithAccount, findClass, findUserByIdentifier } = require('./authController');
const { today } = require('../lib/dates');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const norm = (v) => String(v == null ? '' : v).trim();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/** 管理員可以建立的角色（家長仍走自助註冊，因為需要驗證孩子資料）。*/
const CREATABLE_ROLES = [ROLES.STUDENT, ROLES.LUNCH_LEADER, ROLES.TEACHER, ROLES.ADMIN];

/** 需要班級與座號的角色。*/
const NEEDS_SEAT = [ROLES.STUDENT, ROLES.LUNCH_LEADER];

const BCRYPT_ROUNDS = 10;

// ── 總覽 ────────────────────────────────────────────────────────────

/** GET /api/admin/overview — 名冊與今日狀況的摘要，開發時最常看的一頁。*/
const getOverview = async (req, res) => {
  try {
    const [classesSnap, usersSnap, sessionsSnap, checksSnap] = await Promise.all([
      db.collection(COL.classes).get(),
      db.collection(COL.users).get(),
      db.collection(COL.mealSessions).where('date', '==', today()).get(),
      db.collection(COL.mealChecks).where('date', '==', today()).get(),
    ]);

    const byRole = {};
    usersSnap.docs.forEach((d) => {
      const r = d.data().role || 'unknown';
      byRole[r] = (byRole[r] || 0) + 1;
    });

    return res.status(200).json({
      success: true,
      date: today(),
      classes: classesSnap.size,
      users: usersSnap.size,
      usersByRole: byRole,
      todaySessions: sessionsSnap.docs.map((d) => ({
        classId: d.data().classId,
        className: d.data().className,
        status: d.data().status,
        totalG: d.data().summary ? d.data().summary.totalG : null,
      })),
      todayChecks: {
        total: checksSnap.size,
        finished: checksSnap.docs.filter((d) => d.data().finished).length,
      },
    });
  } catch (error) {
    console.error('取得總覽失敗:', error);
    return bad(res, 500, error.message || '取得總覽失敗');
  }
};

// ── 班級 ────────────────────────────────────────────────────────────

/** GET /api/admin/classes — 班級列表（含實際註冊人數、導師與午餐長）。*/
const listClasses = async (req, res) => {
  try {
    const [classesSnap, usersSnap] = await Promise.all([
      db.collection(COL.classes).get(),
      db.collection(COL.users).get(),
    ]);

    const members = new Map();
    const nameOf = new Map();
    usersSnap.docs.forEach((d) => {
      const u = d.data();
      nameOf.set(d.id, u.displayName || d.id);
      if (!u.classId || !COIN_HOLDER_ROLES.includes(u.role)) return;
      members.set(u.classId, (members.get(u.classId) || 0) + 1);
    });

    const classes = classesSnap.docs
      .map((d) => {
        const c = d.data();
        return {
          classId: d.id,
          grade: c.grade || null,
          name: c.name || null,
          headcount: Number(c.headcount || 0),
          registered: members.get(d.id) || 0,
          teacher: c.teacherUserId ? { userId: c.teacherUserId, displayName: nameOf.get(c.teacherUserId) || null } : null,
          lunchLeader: c.lunchLeaderUserId ? { userId: c.lunchLeaderUserId, displayName: nameOf.get(c.lunchLeaderUserId) || null } : null,
          classCoins: { E: Number(c.eCoin || 0), S: Number(c.sCoin || 0) },
        };
      })
      .sort((a, b) => String(a.grade).localeCompare(String(b.grade)) || String(a.name).localeCompare(String(b.name)));

    return res.status(200).json({ success: true, classes });
  } catch (error) {
    console.error('取得班級列表失敗:', error);
    return bad(res, 500, error.message || '取得班級列表失敗');
  }
};

/**
 * POST /api/admin/classes — 新增班級。
 * body: { grade, name, headcount, classId?, schoolId? }
 * 學生自助註冊前必須先有班級，這是開學第一件事。
 */
const createClass = async (req, res) => {
  try {
    const grade = norm(req.body.grade);
    const name = norm(req.body.name);
    const headcount = Number(req.body.headcount);

    if (!grade || !name) return bad(res, 400, '請填寫年級與班級名稱');
    if (!Number.isFinite(headcount) || headcount <= 0) {
      return bad(res, 400, '班級人數需為正整數（供餐份數要用它換算）');
    }

    const exists = await findClass(grade, name);
    if (exists) return bad(res, 409, `${grade} 年 ${name} 班已存在`);

    // 預設用可讀的 id，重複時退回自動 id
    const preferred = `cls-${grade}${name}`.replace(/[^\w-]/g, '');
    const taken = preferred ? (await db.collection(COL.classes).doc(preferred).get()).exists : true;
    const classId = taken || !preferred ? db.collection(COL.classes).doc().id : preferred;

    const data = {
      classId,
      schoolId: norm(req.body.schoolId) || 'school-demo',
      grade,
      name,
      headcount,
      eCoin: 0,
      sCoin: 0,
      createdBy: req.user.uid,
      createdAt: serverTime(),
      updatedAt: serverTime(),
    };
    await db.collection(COL.classes).doc(classId).set(data);

    return res.status(201).json({
      success: true,
      message: `已新增 ${grade} 年 ${name} 班（人數 ${headcount}）`,
      class: { ...data, createdAt: undefined, updatedAt: undefined },
    });
  } catch (error) {
    console.error('新增班級失敗:', error);
    return bad(res, 500, error.message || '新增班級失敗');
  }
};

/** PATCH /api/admin/classes/:classId — 修改班級（年級、班名、人數）。*/
const updateClass = async (req, res) => {
  try {
    const ref = db.collection(COL.classes).doc(req.params.classId);
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, '查無此班級');

    const updates = { updatedBy: req.user.uid, updatedAt: serverTime() };
    if (req.body.grade !== undefined) updates.grade = norm(req.body.grade);
    if (req.body.name !== undefined) updates.name = norm(req.body.name);
    if (req.body.headcount !== undefined) {
      const headcount = Number(req.body.headcount);
      if (!Number.isFinite(headcount) || headcount <= 0) return bad(res, 400, '班級人數需為正整數');
      updates.headcount = headcount;
    }

    // 改年級/班名時要避免撞到既有班級
    const grade = updates.grade || snap.data().grade;
    const name = updates.name || snap.data().name;
    if (updates.grade || updates.name) {
      const dup = await findClass(grade, name);
      if (dup && dup.id !== req.params.classId) {
        return bad(res, 409, `${grade} 年 ${name} 班已存在`);
      }
    }

    await ref.set(updates, { merge: true });
    return res.status(200).json({ success: true, message: '班級已更新', classId: req.params.classId });
  } catch (error) {
    console.error('更新班級失敗:', error);
    return bad(res, 500, error.message || '更新班級失敗');
  }
};

/**
 * POST /api/admin/classes/:classId/lunch-leader — 指定午餐長。
 * body: { userId } 或 { account }
 * 原本的午餐長會自動降回學生（一班只有一位）。
 */
const setLunchLeader = async (req, res) => {
  try {
    const { classId } = req.params;
    const classRef = db.collection(COL.classes).doc(classId);
    const classSnap = await classRef.get();
    if (!classSnap.exists) return bad(res, 404, '查無此班級');

    const target = req.body.userId
      ? await db.collection(COL.users).doc(String(req.body.userId)).get().then((s) => (s.exists ? { id: s.id, ...s.data() } : null))
      : await findUserByIdentifier(req.body.account);
    if (!target) return bad(res, 404, '查無此使用者');
    if (target.classId !== classId) return bad(res, 400, '該使用者不屬於這個班級');
    if (!COIN_HOLDER_ROLES.includes(target.role)) return bad(res, 400, '只能指派學生擔任午餐長');

    const batch = db.batch();
    const previousId = classSnap.data().lunchLeaderUserId;

    // 舊午餐長降回學生（避免一班出現兩位有紀錄權限的人）
    if (previousId && previousId !== target.id) {
      batch.set(db.collection(COL.users).doc(previousId), {
        role: ROLES.STUDENT,
        updatedBy: req.user.uid,
        updatedAt: serverTime(),
      }, { merge: true });
    }
    batch.set(db.collection(COL.users).doc(target.id), {
      role: ROLES.LUNCH_LEADER,
      updatedBy: req.user.uid,
      updatedAt: serverTime(),
    }, { merge: true });
    batch.set(classRef, { lunchLeaderUserId: target.id, updatedAt: serverTime() }, { merge: true });
    await batch.commit();

    return res.status(200).json({
      success: true,
      message: `已指定 ${target.displayName} 為午餐長`,
      demoted: previousId && previousId !== target.id ? previousId : null,
    });
  } catch (error) {
    console.error('指定午餐長失敗:', error);
    return bad(res, 500, error.message || '指定午餐長失敗');
  }
};

/** POST /api/admin/classes/:classId/teacher — 指定導師。*/
const setTeacher = async (req, res) => {
  try {
    const { classId } = req.params;
    const classRef = db.collection(COL.classes).doc(classId);
    if (!(await classRef.get()).exists) return bad(res, 404, '查無此班級');

    const target = req.body.userId
      ? await db.collection(COL.users).doc(String(req.body.userId)).get().then((s) => (s.exists ? { id: s.id, ...s.data() } : null))
      : await findUserByIdentifier(req.body.account);
    if (!target) return bad(res, 404, '查無此使用者');
    if (target.role !== ROLES.TEACHER && target.role !== ROLES.ADMIN) {
      return bad(res, 400, '只能指派老師或管理員擔任導師');
    }

    const batch = db.batch();
    batch.set(classRef, { teacherUserId: target.id, updatedAt: serverTime() }, { merge: true });
    // 導師的 classId 決定他在「檢查清單」看到哪一班
    batch.set(db.collection(COL.users).doc(target.id), {
      classId,
      updatedBy: req.user.uid,
      updatedAt: serverTime(),
    }, { merge: true });
    await batch.commit();

    return res.status(200).json({ success: true, message: `已指定 ${target.displayName} 為導師` });
  } catch (error) {
    console.error('指定導師失敗:', error);
    return bad(res, 500, error.message || '指定導師失敗');
  }
};

// ── 帳號 ────────────────────────────────────────────────────────────

/** GET /api/admin/users?role=&classId=&q= — 帳號列表（不含密碼雜湊）。*/
const listUsers = async (req, res) => {
  try {
    const role = norm(req.query.role);
    const classId = norm(req.query.classId);
    const q = norm(req.query.q).toLowerCase();

    let query = db.collection(COL.users);
    if (role) query = query.where('role', '==', role);
    if (classId) query = query.where('classId', '==', classId);
    const snap = await query.limit(500).get();

    const users = snap.docs
      .map((d) => {
        const u = d.data();
        return {
          userId: d.id,
          account: u.account || null,
          email: u.email || null,
          displayName: u.displayName || '',
          role: u.role,
          classId: u.classId || null,
          grade: u.grade || null,
          className: u.className || null,
          seatNo: u.seatNo || null,
          isActive: u.isActive !== false,
          isTestAccount: Boolean(u.isTestAccount),
          coins: COIN_HOLDER_ROLES.includes(u.role)
            ? { E: Number(u.eCoin || 0), S: Number(u.sCoin || 0) }
            : null,
          parentUserId: u.parentUserId || null,
          boundStudentId: u.boundStudentId || null,
        };
      })
      .filter((u) => !q || [u.account, u.email, u.displayName].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => String(a.className).localeCompare(String(b.className)) || String(a.seatNo).localeCompare(String(b.seatNo), 'zh-Hant', { numeric: true }));

    return res.status(200).json({ success: true, total: users.length, users });
  } catch (error) {
    console.error('取得帳號列表失敗:', error);
    return bad(res, 500, error.message || '取得帳號列表失敗');
  }
};

/**
 * POST /api/admin/users — 手動新增帳號。
 * body: { role, account, password, displayName, email?, grade?, className?, seatNo? }
 *
 * 學生/午餐長需要年級班級座號（會核對 classes 名冊、檢查座號重複）；
 * 老師只需要指定班級（可用 grade+className 或直接給 classId）；管理員不需班級。
 */
const createUser = async (req, res) => {
  try {
    const role = CREATABLE_ROLES.includes(req.body.role) ? req.body.role : null;
    if (!role) {
      return bad(res, 400, `role 需為 ${CREATABLE_ROLES.join(' / ')}（家長請由家長自行註冊以驗證孩子資料）`);
    }

    const account = norm(req.body.account);
    const displayName = norm(req.body.displayName);
    const password = String(req.body.password || '');
    const email = norm(req.body.email) || null;

    if (!account || !displayName || !password) return bad(res, 400, '請填寫帳號、姓名與密碼');
    if (password.length < 6) return bad(res, 400, '密碼至少需要 6 個字元');

    const userId = db.collection(COL.users).doc().id;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const userData = {
      userId,
      role,
      account,
      email,
      displayName,
      passwordHash,
      isActive: true,
      createdBy: req.user.uid,
      createdAt: serverTime(),
      lastLoginAt: serverTime(),
      ...(COIN_HOLDER_ROLES.includes(role) ? { eCoin: 0, sCoin: 0, score: 0 } : {}),
    };

    // 需要班級的角色：核對名冊
    if (role !== ROLES.ADMIN) {
      const grade = norm(req.body.grade);
      const className = norm(req.body.className);
      let klass = null;

      if (req.body.classId) {
        const snap = await db.collection(COL.classes).doc(String(req.body.classId)).get();
        if (!snap.exists) return bad(res, 404, '查無此班級');
        klass = { id: snap.id, ...snap.data() };
      } else {
        if (!grade || !className) return bad(res, 400, '請指定班級（年級 + 班名，或直接給 classId）');
        klass = await findClass(grade, className);
        if (!klass) return bad(res, 404, `查無 ${grade} 年 ${className} 班，請先新增班級`);
      }

      userData.classId = klass.id;
      userData.grade = klass.grade;
      userData.className = klass.name;
      userData.schoolId = klass.schoolId || null;

      if (NEEDS_SEAT.includes(role)) {
        const seatNo = norm(req.body.seatNo);
        if (!seatNo) return bad(res, 400, '學生與午餐長需要座號');
        const taken = await db.collection(COL.users)
          .where('classId', '==', klass.id)
          .where('seatNo', '==', seatNo)
          .limit(1)
          .get();
        if (!taken.empty) return bad(res, 409, `座號 ${seatNo} 已被使用`);
        userData.seatNo = seatNo;
      }
    }

    const extraWrites = [];
    if (role === ROLES.LUNCH_LEADER && userData.classId) {
      extraWrites.push({
        ref: db.collection(COL.classes).doc(userData.classId),
        data: { lunchLeaderUserId: userId, updatedAt: serverTime() },
      });
    }
    if (role === ROLES.TEACHER && userData.classId) {
      extraWrites.push({
        ref: db.collection(COL.classes).doc(userData.classId),
        data: { teacherUserId: userId, updatedAt: serverTime() },
      });
    }

    try {
      await createUserWithAccount({ userId, account, userData, extraWrites });
    } catch (err) {
      if (err.status === 409) return bad(res, 409, err.message);
      throw err;
    }

    return res.status(201).json({
      success: true,
      message: `已建立 ${role} 帳號：${account}`,
      user: {
        userId,
        account,
        displayName,
        role,
        classId: userData.classId || null,
        className: userData.className || null,
        seatNo: userData.seatNo || null,
      },
    });
  } catch (error) {
    console.error('新增帳號失敗:', error);
    return bad(res, 500, error.message || '新增帳號失敗');
  }
};

/**
 * PATCH /api/admin/users/:userId — 改角色 / 改班級座號 / 停用啟用 / 重設密碼。
 * body: { role?, classId?, seatNo?, displayName?, isActive?, password? }
 */
const updateUser = async (req, res) => {
  try {
    const ref = db.collection(COL.users).doc(req.params.userId);
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, '查無此使用者');
    const current = snap.data();

    const updates = { updatedBy: req.user.uid, updatedAt: serverTime() };

    if (req.body.displayName !== undefined) updates.displayName = norm(req.body.displayName);
    if (req.body.isActive !== undefined) updates.isActive = Boolean(req.body.isActive);

    if (req.body.role !== undefined) {
      if (!ALL_ROLES.includes(req.body.role)) return bad(res, 400, '未知的角色');
      if (req.body.role === ROLES.PARENT) return bad(res, 400, '不可改為家長（家長需經孩子資料驗證）');
      updates.role = req.body.role;
      // 升成持幣角色但還沒有幣欄位時補 0，避免 undefined 進運算
      if (COIN_HOLDER_ROLES.includes(req.body.role) && current.eCoin === undefined) {
        updates.eCoin = 0;
        updates.sCoin = 0;
        updates.score = 0;
      }
    }

    if (req.body.classId !== undefined) {
      const classSnap = await db.collection(COL.classes).doc(String(req.body.classId)).get();
      if (!classSnap.exists) return bad(res, 404, '查無此班級');
      const c = classSnap.data();
      updates.classId = classSnap.id;
      updates.grade = c.grade;
      updates.className = c.name;
      updates.schoolId = c.schoolId || null;
    }

    if (req.body.seatNo !== undefined) {
      const seatNo = norm(req.body.seatNo);
      const classId = updates.classId || current.classId;
      if (seatNo && classId) {
        const taken = await db.collection(COL.users)
          .where('classId', '==', classId)
          .where('seatNo', '==', seatNo)
          .limit(2)
          .get();
        if (taken.docs.some((d) => d.id !== req.params.userId)) {
          return bad(res, 409, `座號 ${seatNo} 已被使用`);
        }
      }
      updates.seatNo = seatNo;
    }

    if (req.body.password !== undefined) {
      const password = String(req.body.password);
      if (password.length < 6) return bad(res, 400, '密碼至少需要 6 個字元');
      updates.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      updates.passwordResetBy = req.user.uid;
      updates.passwordResetAt = serverTime();
    }

    await ref.set(updates, { merge: true });

    // 角色改動要同步班級的午餐長欄位，避免名冊與角色對不上
    if (updates.role) {
      const classId = updates.classId || current.classId;
      if (classId) {
        const classRef = db.collection(COL.classes).doc(classId);
        const classSnap = await classRef.get();
        if (classSnap.exists) {
          const c = classSnap.data();
          if (updates.role === ROLES.LUNCH_LEADER) {
            await classRef.set({ lunchLeaderUserId: req.params.userId }, { merge: true });
          } else if (c.lunchLeaderUserId === req.params.userId) {
            await classRef.set({ lunchLeaderUserId: null }, { merge: true });
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: '已更新',
      changed: Object.keys(updates).filter((k) => !['updatedBy', 'updatedAt', 'passwordHash'].includes(k))
        .concat(updates.passwordHash ? ['password'] : []),
    });
  } catch (error) {
    console.error('更新帳號失敗:', error);
    return bad(res, 500, error.message || '更新帳號失敗');
  }
};

module.exports = {
  getOverview,
  listClasses,
  createClass,
  updateClass,
  setLunchLeader,
  setTeacher,
  listUsers,
  createUser,
  updateUser,
  CREATABLE_ROLES,
};
