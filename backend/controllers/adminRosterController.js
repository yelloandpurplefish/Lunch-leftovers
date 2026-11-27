/**
 * 管理員：班級與帳號（任何班級、任何角色都能操作）。
 *
 * 介面的設計是「先找到人或班級，再對它操作」，不再一次把全校列出來：
 *   班級   GET /classes（精簡清單）→ GET /classes/:id（名冊、導師、午餐長、當天稱重與餐盤）
 *   帳號   GET /users?q=（帳號／Email／姓名開頭搜尋）或 ?role=&classId=（分頁）
 *          → GET /users/:id（依角色帶出能做的事：幣、餐盤、家長綁定、導師班級…）
 *
 * 會同時動到兩份資料的寫入（導師、午餐長、家長綁定、班名副本）一律走 lib/roster.js，
 * 幣與餐盤一律走 lib/coins.js、lib/plates.js，不在這裡直接改欄位。
 */
const bcrypt = require('bcryptjs');
const { db, admin } = require('../config/firebase');
const { COL, ROLES, ALL_ROLES, COIN_HOLDER_ROLES, COIN_SOURCES, PLATE, plateTier } = require('../config/schema');
const { createUserWithAccount, findClass, findUserByIdentifier } = require('./authController');
const { today, isYmd } = require('../lib/dates');
const roster = require('../lib/roster');
const coins = require('../lib/coins');
const plates = require('../lib/plates');
const deletion = require('../lib/deletion');
const { recentOf } = require('./plateController');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const { norm, classLabel } = roster;
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = (label, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error.status && error.status < 500) return bad(res, error.status, error.message);
    console.error(`${label}失敗:`, error);
    return bad(res, 500, error.message || `${label}失敗`);
  }
};

/** 管理員可以建立的角色（家長走自助註冊，因為要驗證孩子資料；建好後可以在這裡改綁定）。*/
const CREATABLE_ROLES = [ROLES.STUDENT, ROLES.TEACHER, ROLES.TECHNICIAN, ROLES.ADMIN];
const BCRYPT_ROUNDS = 10;

const ROLE_LABEL = { student: '學生', parent: '家長', teacher: '老師', technician: '技術員', admin: '管理員' };

async function loadUser(userId) {
  const snap = await db.collection(COL.users).doc(String(userId)).get();
  if (!snap.exists) throw fail(404, '查無此使用者');
  return { id: snap.id, ref: snap.ref, ...snap.data() };
}

async function loadClass(classId) {
  const snap = await db.collection(COL.classes).doc(String(classId)).get();
  if (!snap.exists) throw fail(404, '查無此班級');
  return { id: snap.id, ref: snap.ref, ...snap.data() };
}

/** 帳號列表與搜尋結果的一列。 */
function userRow(id, u) {
  return {
    userId: id,
    displayName: u.displayName || '',
    account: u.account || null,
    email: u.email || null,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role] || u.role,
    classId: u.classId || null,
    classLabel: u.classId ? classLabel(u.grade, u.className) : null,
    seatNo: u.seatNo || null,
    isActive: u.isActive !== false,
    esgCoin: COIN_HOLDER_ROLES.includes(u.role) ? Number(u.esgCoin || 0) : null,
  };
}

const bySeat = (a, b) => String(a.seatNo || '').localeCompare(String(b.seatNo || ''), 'zh-Hant', { numeric: true });

// ── 總覽 ────────────────────────────────────────────────────────────

/** GET /api/admin/overview — 人數、今天各班稱重與拍餐盤的進度。 */
const getOverview = handle('取得總覽', async (req, res) => {
  const date = today();
  const [classesSnap, usersSnap, sessionsSnap, platesSnap] = await Promise.all([
    db.collection(COL.classes).get(),
    db.collection(COL.users).select('role', 'classId', 'isActive').get(),
    db.collection(COL.mealSessions).where('date', '==', date).get(),
    db.collection(COL.plateScans).where('date', '==', date).select('classId', 'level').get(),
  ]);

  const byRole = {};
  const students = new Map();
  usersSnap.docs.forEach((d) => {
    const u = d.data();
    byRole[u.role || 'unknown'] = (byRole[u.role || 'unknown'] || 0) + 1;
    if (u.role === ROLES.STUDENT && u.isActive !== false && u.classId) {
      students.set(u.classId, (students.get(u.classId) || 0) + 1);
    }
  });
  const session = new Map(sessionsSnap.docs.map((d) => [d.data().classId, d.data().status]));
  const scanned = new Map();
  platesSnap.docs.forEach((d) => scanned.set(d.data().classId, (scanned.get(d.data().classId) || 0) + 1));

  const classes = classesSnap.docs.map((d) => ({
    classId: d.id,
    label: classLabel(d.data().grade, d.data().name),
    grade: d.data().grade || '',
    students: students.get(d.id) || 0,
    weighing: session.get(d.id) || 'none',
    plates: scanned.get(d.id) || 0,
  })).sort((a, b) => String(a.grade).localeCompare(String(b.grade), 'zh-Hant', { numeric: true })
    || a.label.localeCompare(b.label, 'zh-Hant', { numeric: true }));

  return res.status(200).json({
    success: true,
    date,
    usersByRole: byRole,
    roleLabels: ROLE_LABEL,
    totals: {
      classes: classes.length,
      weighed: classes.filter((c) => c.weighing === 'done').length,
      weighing: classes.filter((c) => c.weighing === 'measuring').length,
      plates: platesSnap.size,
      students: [...students.values()].reduce((a, b) => a + b, 0),
    },
    classes,
  });
});

// ── 班級 ────────────────────────────────────────────────────────────

/** GET /api/admin/classes — 精簡清單（給班級選單用）。 */
const listClasses = handle('取得班級列表', async (req, res) => {
  const [classesSnap, studentsSnap] = await Promise.all([
    db.collection(COL.classes).get(),
    db.collection(COL.users).where('role', '==', ROLES.STUDENT).select('classId').get(),
  ]);
  const count = new Map();
  studentsSnap.docs.forEach((d) => count.set(d.data().classId, (count.get(d.data().classId) || 0) + 1));
  const classes = classesSnap.docs.map((d) => {
    const c = d.data();
    return {
      classId: d.id,
      grade: c.grade || '',
      name: c.name || '',
      label: classLabel(c.grade, c.name),
      headcount: Number(c.headcount || 0),
      registered: count.get(d.id) || 0,
      hasTeacher: Boolean(c.teacherUserId),
      hasLeader: Boolean(c.lunchLeaderUserId),
    };
  }).sort((a, b) => String(a.grade).localeCompare(String(b.grade), 'zh-Hant', { numeric: true })
    || a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }));
  return res.status(200).json({ success: true, classes });
});

/**
 * GET /api/admin/classes/:classId?date=
 * 一個班的全部：基本資料、導師、午餐長、學生名冊（含 ESG 與這天的餐盤）、這天的稱重狀態。
 */
const getClassDetail = handle('取得班級資料', async (req, res) => {
  const c = await loadClass(req.params.classId);
  const date = isYmd(req.query.date) ? req.query.date : today();
  const [membersSnap, platesSnap, sessionSnap] = await Promise.all([
    db.collection(COL.users).where('classId', '==', c.id).get(),
    db.collection(COL.plateScans).where('classId', '==', c.id).where('date', '==', date).get(),
    db.collection(COL.mealSessions).doc(`${c.id}_${date}`).get(),
  ]);
  const plateByUser = new Map(platesSnap.docs.map((d) => [d.data().userId, plates.present(d.id, d.data())]));
  const members = membersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const teacher = c.teacherUserId ? await db.collection(COL.users).doc(c.teacherUserId).get() : null;
  const leader = members.find((m) => m.id === c.lunchLeaderUserId && m.role === ROLES.STUDENT) || null;

  const students = members.filter((m) => m.role === ROLES.STUDENT).map((m) => ({
    ...userRow(m.id, m),
    isLunchLeader: Boolean(leader && leader.id === m.id),
    plate: plateByUser.get(m.id) || null,
  })).sort(bySeat);
  const others = members.filter((m) => m.role !== ROLES.STUDENT).map((m) => userRow(m.id, m));

  const s = sessionSnap.exists ? sessionSnap.data() : null;
  const dishes = s && s.dishes ? Object.values(s.dishes).filter((x) => x && x.dishId) : [];
  return res.status(200).json({
    success: true,
    date,
    class: {
      classId: c.id,
      grade: c.grade || '',
      name: c.name || '',
      label: classLabel(c.grade, c.name),
      headcount: Number(c.headcount || 0),
      schoolId: c.schoolId || null,
    },
    teacher: teacher && teacher.exists
      ? { userId: teacher.id, displayName: teacher.data().displayName || '', account: teacher.data().account || null }
      : null,
    lunchLeader: leader ? { userId: leader.id, displayName: leader.displayName || '', account: leader.account || null } : null,
    students,
    others,
    weighing: s
      ? { status: s.status, done: dishes.filter((x) => x.weighedAt).length, total: dishes.length,
        totalG: s.summary ? s.summary.totalG : null }
      : { status: 'none' },
    plateSummary: {
      scanned: students.filter((x) => x.plate).length,
      total: students.filter((x) => x.isActive).length,
      byLevel: Object.fromEntries(PLATE.tiers.map((t) => [t.level, students.filter((x) => x.plate && x.plate.level === t.level).length])),
    },
  });
});

/**
 * POST /api/admin/classes — 新增班級。body: { grade, name, headcount, schoolId? }
 * classId 由年級與班名決定（見 lib/roster.js classIdFor）：3、302 → cls-302。
 */
const createClass = handle('新增班級', async (req, res) => {
  const grade = norm(req.body.grade);
  const name = norm(req.body.name);
  const headcount = Number(req.body.headcount);
  if (!grade || !name) return bad(res, 400, '請填寫年級與班級名稱');
  if (!Number.isInteger(headcount) || headcount <= 0) {
    return bad(res, 400, '班級人數需為正整數（供餐份數要用它換算）');
  }
  const { classId: preferred, error } = roster.classIdFor(grade, name);
  if (error) return bad(res, 400, error);

  const dup = await findClass(grade, name);
  if (dup) return bad(res, 409, `${classLabel(grade, name)}已存在（${dup.id}）`);
  if (preferred) {
    const taken = await db.collection(COL.classes).doc(preferred).get();
    if (taken.exists) {
      return bad(res, 409, `代號 ${preferred} 已經被「${classLabel(taken.data().grade, taken.data().name)}」使用，`
        + '同一個班不要用兩種寫法建立（例如 302 與 3 年 2 班）');
    }
  }
  const classId = preferred || db.collection(COL.classes).doc().id;
  const data = {
    classId,
    schoolId: norm(req.body.schoolId) || 'school-demo',
    grade,
    name,
    headcount,
    createdBy: req.user.uid,
    createdAt: serverTime(),
    updatedAt: serverTime(),
  };
  await db.collection(COL.classes).doc(classId).create(data);
  return res.status(201).json({
    success: true,
    message: `已新增 ${classLabel(grade, name)}（${classId}，${headcount} 人）`,
    class: { classId, grade, name, headcount, label: classLabel(grade, name) },
  });
});

/** PATCH /api/admin/classes/:classId — 改年級／班名／人數；班名副本同步到學生與秤。 */
const updateClass = handle('更新班級', async (req, res) => {
  const c = await loadClass(req.params.classId);
  const updates = { updatedBy: req.user.uid, updatedAt: serverTime() };
  if (req.body.grade !== undefined) updates.grade = norm(req.body.grade);
  if (req.body.name !== undefined) updates.name = norm(req.body.name);
  if (req.body.headcount !== undefined) {
    const headcount = Number(req.body.headcount);
    if (!Number.isInteger(headcount) || headcount <= 0) return bad(res, 400, '班級人數需為正整數');
    updates.headcount = headcount;
  }
  const grade = updates.grade !== undefined ? updates.grade : c.grade;
  const name = updates.name !== undefined ? updates.name : c.name;
  if (!grade || !name) return bad(res, 400, '年級與班級名稱不能是空的');
  if (updates.grade !== undefined || updates.name !== undefined) {
    const { error } = roster.classIdFor(grade, name);
    if (error) return bad(res, 400, error);
    const dup = await findClass(grade, name);
    if (dup && dup.id !== c.id) return bad(res, 409, `${classLabel(grade, name)}已存在（${dup.id}）`);
  }
  await c.ref.set(updates, { merge: true });
  const synced = await roster.syncClassCopies(c.id);
  return res.status(200).json({
    success: true,
    message: `已更新 ${classLabel(grade, name)}`
      + (synced.users || synced.devices ? `（同步 ${synced.users} 個帳號、${synced.devices} 台秤的班名）` : ''),
    synced,
  });
});

/** DELETE /api/admin/classes/:classId — 只在沒有任何依賴時才刪（見 lib/deletion.js）。 */
const deleteClass = handle('刪除班級', async (req, res) => {
  const c = await loadClass(req.params.classId);
  const deps = await deletion.classDependencies(c.id);
  if (deps.length) {
    return bad(res, 409, `「${classLabel(c.grade, c.name)}」還有資料，不能刪除：${deletion.describe(deps)}`,
      { dependencies: deps });
  }
  await c.ref.delete();
  return res.status(200).json({ success: true, message: `已刪除「${classLabel(c.grade, c.name)}」（${c.id}）`, classId: c.id });
});

/** 用 userId 或帳號找人。 */
async function resolveUser(body) {
  if (body.userId) return loadUser(body.userId);
  const u = await findUserByIdentifier(body.account);
  if (!u) throw fail(404, '查無此帳號');
  return { ...u, ref: db.collection(COL.users).doc(u.id) };
}

/** POST /api/admin/classes/:classId/teacher  body: { userId | account } */
const setTeacher = handle('指定導師', async (req, res) => {
  const target = await resolveUser(req.body);
  const r = await roster.setHomeroom(req.params.classId, target.id, req.user.uid);
  return res.status(200).json({ success: true, message: `已指定 ${r.teacher.displayName} 為導師` });
});

/** DELETE /api/admin/classes/:classId/teacher */
const clearTeacher = handle('清除導師', async (req, res) => {
  await roster.setHomeroom(req.params.classId, null, req.user.uid);
  return res.status(200).json({ success: true, message: '已清除導師' });
});

/** POST /api/admin/classes/:classId/lunch-leader  body: { userId | account } */
const setLunchLeader = handle('指定午餐長', async (req, res) => {
  const target = await resolveUser(req.body);
  const r = await roster.setLunchLeader(req.params.classId, target.id, req.user.uid);
  return res.status(200).json({
    success: true,
    message: `已指定 ${target.displayName} 為午餐長`,
    replaced: r.previous && r.previous !== target.id ? r.previous : null,
  });
});

/** DELETE /api/admin/classes/:classId/lunch-leader */
const clearLunchLeader = handle('清除午餐長', async (req, res) => {
  await roster.setLunchLeader(req.params.classId, null, req.user.uid);
  return res.status(200).json({ success: true, message: '已清除午餐長' });
});

// ── 帳號：搜尋與分頁 ─────────────────────────────────────────────────

/**
 * GET /api/admin/users
 *   ?q=      帳號／Email／姓名的開頭（不分大小寫比對帳號；姓名照字比對）。最多回 30 筆。
 *   ?role=&classId=&after=&limit=   依角色、班級列出，用 after（上一頁最後一筆的 userId）往下翻。
 *
 * 不再一次撈全部：全校上千個帳號用一張清單瀏覽不實際，也會把資料庫讀取量撐大。
 */
const listUsers = handle('取得帳號', async (req, res) => {
  const q = norm(req.query.q);
  const role = norm(req.query.role);
  const classId = norm(req.query.classId);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  if (q) {
    const lower = q.toLowerCase();
    const END = '';
    const [idxSnap, nameSnap] = await Promise.all([
      db.collection(COL.accountIndex)
        .where(admin.firestore.FieldPath.documentId(), '>=', lower)
        .where(admin.firestore.FieldPath.documentId(), '<', lower + END)
        .limit(30).get(),
      db.collection(COL.users).where('displayName', '>=', q).where('displayName', '<', q + END).limit(30).get(),
    ]);
    const ids = new Set([...idxSnap.docs.map((d) => d.data().userId), ...nameSnap.docs.map((d) => d.id)].filter(Boolean));
    const snaps = ids.size ? await db.getAll(...[...ids].slice(0, 60).map((id) => db.collection(COL.users).doc(id))) : [];
    const users = snaps.filter((s) => s.exists)
      .map((s) => userRow(s.id, s.data()))
      .filter((u) => (!role || u.role === role) && (!classId || u.classId === classId))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'))
      .slice(0, 30);
    return res.status(200).json({ success: true, mode: 'search', users, truncated: ids.size > 30 });
  }

  let query = db.collection(COL.users);
  if (role) query = query.where('role', '==', role);
  if (classId) query = query.where('classId', '==', classId);
  const total = (await query.count().get()).data().count;
  let page = query.orderBy(admin.firestore.FieldPath.documentId());
  if (req.query.after) page = page.startAfter(String(req.query.after));
  const snap = await page.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  return res.status(200).json({
    success: true,
    mode: 'list',
    total,
    users: docs.map((d) => userRow(d.id, d.data())),
    next: snap.docs.length > limit ? docs[docs.length - 1].id : null,
  });
});

/**
 * GET /api/admin/users/:userId
 * 一個人的全部，依角色帶出能做的事所需的資料。
 */
const getUserDetail = handle('取得帳號資料', async (req, res) => {
  const u = await loadUser(req.params.userId);
  const out = { success: true, user: userRow(u.id, u), lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toDate().toISOString() : null };

  if (u.classId) {
    const c = await db.collection(COL.classes).doc(u.classId).get();
    out.class = c.exists
      ? { classId: c.id, label: classLabel(c.data().grade, c.data().name), lunchLeaderUserId: c.data().lunchLeaderUserId || null, teacherUserId: c.data().teacherUserId || null }
      : { classId: u.classId, label: null, missing: true };
    out.user.isLunchLeader = Boolean(c.exists && u.role === ROLES.STUDENT && c.data().lunchLeaderUserId === u.id);
  }

  if (u.role === ROLES.STUDENT) {
    const [ledgerSnap, recent, parentsSnap] = await Promise.all([
      db.collection(COL.coinTx).where('ownerType', '==', 'user').where('ownerId', '==', u.id)
        .orderBy('createdAt', 'desc').limit(15).get(),
      recentOf(u.id, 14),
      db.collection(COL.users).where('boundStudentId', '==', u.id).limit(3).get(),
    ]);
    out.ledger = ledgerSnap.docs.map((d) => {
      const t = d.data();
      return {
        amount: t.amount, reason: t.reason, date: t.date,
        source: t.source ? COIN_SOURCES[t.source] || t.source : null,
        at: t.createdAt ? t.createdAt.toDate().toISOString() : null,
      };
    });
    out.plates = recent;
    out.parents = parentsSnap.docs.map((d) => ({ userId: d.id, displayName: d.data().displayName || '', account: d.data().account || null }));
  }

  if (u.role === ROLES.PARENT && u.boundStudentId) {
    const s = await db.collection(COL.users).doc(u.boundStudentId).get();
    out.boundStudent = s.exists
      ? { userId: s.id, displayName: s.data().displayName || '', account: s.data().account || null,
        classLabel: s.data().classId ? classLabel(s.data().grade, s.data().className) : null, seatNo: s.data().seatNo || null }
      : { userId: u.boundStudentId, missing: true };
  }

  if (u.role === ROLES.TEACHER) {
    const home = await db.collection(COL.classes).where('teacherUserId', '==', u.id).get();
    out.homeroomOf = home.docs.map((d) => ({ classId: d.id, label: classLabel(d.data().grade, d.data().name) }));
  }

  out.tiers = PLATE.tiers.map((t) => ({ level: t.level, label: t.label, minPct: t.minPct, maxPct: t.maxPct }));
  return res.status(200).json(out);
});

// ── 帳號：新增、修改、刪除 ───────────────────────────────────────────

/**
 * POST /api/admin/users — 手動新增帳號。
 * body: { role, account, password, displayName, email?, classId? | (grade + className), seatNo? }
 */
const createUser = handle('新增帳號', async (req, res) => {
  const role = CREATABLE_ROLES.includes(req.body.role) ? req.body.role : null;
  if (!role) {
    return bad(res, 400, `角色需為 ${CREATABLE_ROLES.map((r) => ROLE_LABEL[r]).join('／')}（家長請由家長自行註冊以驗證孩子資料）`);
  }
  const account = norm(req.body.account);
  const displayName = norm(req.body.displayName);
  const password = String(req.body.password || '');
  const email = norm(req.body.email) || null;
  if (!account || !displayName || !password) return bad(res, 400, '請填寫帳號、姓名與密碼');
  if (password.length < 6) return bad(res, 400, '密碼至少需要 6 個字元');

  const userId = db.collection(COL.users).doc().id;
  const userData = {
    userId, role, account, email, displayName,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    isActive: true,
    createdBy: req.user.uid,
    createdAt: serverTime(),
    ...(COIN_HOLDER_ROLES.includes(role) ? { esgCoin: 0 } : {}),
  };

  let klass = null;
  if (req.body.classId) {
    klass = await loadClass(req.body.classId);
  } else if (norm(req.body.grade) || norm(req.body.className)) {
    const found = await findClass(norm(req.body.grade), norm(req.body.className));
    if (!found) return bad(res, 404, `查無 ${classLabel(req.body.grade, req.body.className)}，請先新增班級`);
    klass = found;
  }
  if (role === ROLES.STUDENT && !klass) return bad(res, 400, '學生需要指定班級');
  if (klass) Object.assign(userData, { classId: klass.id, grade: klass.grade, className: klass.name, schoolId: klass.schoolId || null });

  if (role === ROLES.STUDENT) {
    const seatNo = norm(req.body.seatNo);
    if (!seatNo) return bad(res, 400, '學生需要座號');
    await assertSeatFree(klass.id, seatNo, null);
    userData.seatNo = seatNo;
  }

  try {
    await createUserWithAccount({ userId, account, userData });
  } catch (err) {
    if (err.status === 409) return bad(res, 409, err.message);
    throw err;
  }
  // 新老師且班上還沒有導師 → 直接當導師；已經有了就只是掛在這個班（協同）
  let note = '';
  if (role === ROLES.TEACHER && klass && !klass.teacherUserId) {
    await roster.setHomeroom(klass.id, userId, req.user.uid);
    note = `，並擔任${classLabel(klass.grade, klass.name)}導師`;
  }
  return res.status(201).json({
    success: true,
    message: `已建立${ROLE_LABEL[role]}帳號：${account}${note}`,
    user: userRow(userId, userData),
  });
});

async function assertSeatFree(classId, seatNo, selfId) {
  const taken = await db.collection(COL.users)
    .where('classId', '==', classId).where('seatNo', '==', seatNo).limit(2).get();
  if (taken.docs.some((d) => d.id !== selfId)) throw fail(409, `座號 ${seatNo} 在這個班已被使用`);
}

/**
 * PATCH /api/admin/users/:userId
 * body: { displayName?, isActive?, role?, classId?（null＝離開班級）, seatNo?, password? }
 *
 * 一次讀完需要的資料、一個 batch 寫完，連帶的指標一起改：
 *   · 學生換班或不再是學生 → 原班午餐長指標清掉
 *   · 老師換班或不再是老師 → 原班導師指標清掉
 *   · 換班 → 年級／班名副本跟著換，並檢查新班座號沒有重複
 */
const updateUser = handle('更新帳號', async (req, res) => {
  const u = await loadUser(req.params.userId);
  const body = req.body || {};
  const updates = { updatedBy: req.user.uid, updatedAt: serverTime() };

  if (body.displayName !== undefined) {
    if (!norm(body.displayName)) return bad(res, 400, '姓名不能是空的');
    updates.displayName = norm(body.displayName);
  }
  if (body.isActive !== undefined) {
    if (u.id === req.user.uid && !body.isActive) return bad(res, 400, '不能停用自己的帳號');
    updates.isActive = Boolean(body.isActive);
  }

  let role = u.role;
  if (body.role !== undefined && body.role !== u.role) {
    if (!ALL_ROLES.includes(body.role)) return bad(res, 400, '未知的角色');
    if (body.role === ROLES.PARENT || u.role === ROLES.PARENT) {
      return bad(res, 400, '家長帳號與其他角色不能互換（家長需經孩子資料驗證）；不需要的話請停用或刪除');
    }
    if (u.id === req.user.uid) return bad(res, 400, '不能改自己的角色');
    role = body.role;
    updates.role = role;
    if (COIN_HOLDER_ROLES.includes(role) && u.esgCoin === undefined) updates.esgCoin = 0;
  }

  let classId = u.classId || null;
  let klass = null;
  if (body.classId !== undefined) {
    if (body.classId) {
      klass = await loadClass(body.classId);
      classId = klass.id;
      Object.assign(updates, { classId, grade: klass.grade || null, className: klass.name || null, schoolId: klass.schoolId || null });
    } else {
      classId = null;
      Object.assign(updates, { classId: null, grade: null, className: null, seatNo: null });
    }
  }
  let seatNo = u.seatNo || null;
  if (body.seatNo !== undefined) {
    seatNo = norm(body.seatNo) || null;
    updates.seatNo = seatNo;
  }

  if (role === ROLES.STUDENT) {
    if (!classId) return bad(res, 400, '學生一定要有班級');
    if (!seatNo) return bad(res, 400, '學生一定要有座號');
    const moved = classId !== (u.classId || null) || seatNo !== (u.seatNo || null) || role !== u.role;
    if (moved) await assertSeatFree(classId, seatNo, u.id);
  }

  if (body.password !== undefined) {
    const password = String(body.password);
    if (password.length < 6) return bad(res, 400, '密碼至少需要 6 個字元');
    updates.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    updates.passwordResetBy = req.user.uid;
    updates.passwordResetAt = serverTime();
  }

  const batch = db.batch();
  batch.set(u.ref, updates, { merge: true });

  const leftClass = u.classId && classId !== u.classId;
  if (u.classId && (leftClass || (u.role === ROLES.STUDENT && role !== ROLES.STUDENT))) {
    const old = await db.collection(COL.classes).doc(u.classId).get();
    if (old.exists && old.data().lunchLeaderUserId === u.id) {
      batch.set(old.ref, { lunchLeaderUserId: null, updatedAt: serverTime() }, { merge: true });
    }
  }
  if (u.role === ROLES.TEACHER && (leftClass || role !== ROLES.TEACHER)) {
    const home = await db.collection(COL.classes).where('teacherUserId', '==', u.id).get();
    home.docs.filter((d) => role !== ROLES.TEACHER || d.id !== classId)
      .forEach((d) => batch.set(d.ref, { teacherUserId: null, updatedAt: serverTime() }, { merge: true }));
  }
  await batch.commit();

  return res.status(200).json({
    success: true,
    message: '已更新',
    changed: Object.keys(updates).filter((k) => !['updatedBy', 'updatedAt', 'passwordHash', 'passwordResetBy', 'passwordResetAt'].includes(k))
      .concat(updates.passwordHash ? ['password'] : []),
  });
});

/**
 * DELETE /api/admin/users/:userId
 * 只在沒有活動紀錄時才刪（有的話請停用，歷史才留得住）。刪除時一併清掉所有指向他的指標。
 */
const deleteUser = handle('刪除帳號', async (req, res) => {
  const u = await loadUser(req.params.userId);
  if (u.id === req.user.uid) return bad(res, 400, '不能刪除自己的帳號');
  const deps = await deletion.userDependencies(u.id);
  if (deps.length) {
    return bad(res, 409,
      `「${u.displayName || u.id}」已經有活動紀錄，不能刪除：${deletion.describe(deps)}。要讓他無法登入請改用「停用」，歷史資料才留得住。`,
      { dependencies: deps, suggestion: 'deactivate' });
  }

  const batch = db.batch();
  batch.delete(u.ref);
  // 帳號鎖：不清掉的話這個帳號名稱會永久無法重建（只刪指向自己的那一筆）
  for (const key of [u.account, u.email].filter(Boolean).map((v) => String(v).toLowerCase())) {
    const idx = await db.collection(COL.accountIndex).doc(key).get();
    if (idx.exists && idx.data().userId === u.id) batch.delete(idx.ref);
  }
  const [leaderOf, homeroomOf] = await Promise.all([
    db.collection(COL.classes).where('lunchLeaderUserId', '==', u.id).get(),
    db.collection(COL.classes).where('teacherUserId', '==', u.id).get(),
  ]);
  leaderOf.docs.forEach((d) => batch.set(d.ref, { lunchLeaderUserId: null, updatedAt: serverTime() }, { merge: true }));
  homeroomOf.docs.forEach((d) => batch.set(d.ref, { teacherUserId: null, updatedAt: serverTime() }, { merge: true }));
  if (u.role === ROLES.PARENT && u.boundStudentId) {
    const s = await db.collection(COL.users).doc(u.boundStudentId).get();
    if (s.exists && s.data().parentUserId === u.id) batch.set(s.ref, { parentUserId: null }, { merge: true });
  }
  await batch.commit();
  return res.status(200).json({ success: true, message: `已刪除「${u.displayName || u.id}」，帳號 ${u.account || '(無)'} 可以重新使用`, userId: u.id });
});

// ── 依角色的操作 ─────────────────────────────────────────────────────

/** POST /api/admin/users/:userId/coins  body: { amount, reason }（學生；可正可負） */
const adjustCoins = handle('調整 ESG 幣', async (req, res) => {
  const r = await coins.adjustUser({
    userId: req.params.userId, amount: req.body.amount, reason: req.body.reason, by: req.user.uid,
  });
  return res.status(200).json({ success: true, message: `已${r.applied > 0 ? '增加' : '扣除'} ${Math.abs(r.applied)} ESG 幣，餘額 ${r.balanceAfter}`, ...r });
});

/** 管理員更正時用級距選，存一個落在該級中間的代表百分比。 */
const LEVEL_PCT = { clean: 0, little: 12, half: 35, most: 75 };

/**
 * PUT /api/admin/users/:userId/plates/:date
 * body: { level } 或 { leftoverPct }，加 note（原因）
 * 辨識錯了、照片拍壞、模型沒接上時，由管理員直接標記這天的結果；幣自動補或收回差額。
 */
const setPlate = handle('更正餐盤結果', async (req, res) => {
  const { date } = req.params;
  if (!isYmd(date)) return bad(res, 400, '日期格式需為 YYYY-MM-DD');
  if (date > today()) return bad(res, 400, '不能標記未來的日期');
  let pct = req.body.leftoverPct;
  if (pct === undefined || pct === null || pct === '') {
    if (!(req.body.level in LEVEL_PCT)) return bad(res, 400, `請選擇級距（${PLATE.tiers.map((t) => t.label).join('／')}）`);
    pct = LEVEL_PCT[req.body.level];
  }
  const r = await plates.writeResult({
    userId: req.params.userId, date, mode: 'override', leftoverPct: pct, by: req.user.uid, note: norm(req.body.note),
  });
  const change = r.delta === 0 ? '幣不變' : `ESG 幣 ${r.delta > 0 ? '+' : ''}${r.delta}`;
  return res.status(200).json({ success: true, message: `已標記 ${date} 為「${r.tier.label}」（${change}）`, ...r });
});

/** DELETE /api/admin/users/:userId/plates/:date — 清除這天的結果（收回幣），學生可以重拍。 */
const clearPlate = handle('清除餐盤結果', async (req, res) => {
  const { date } = req.params;
  if (!isYmd(date)) return bad(res, 400, '日期格式需為 YYYY-MM-DD');
  const r = await plates.clearResult({ userId: req.params.userId, date, by: req.user.uid, note: norm(req.query.note) });
  return res.status(200).json({ success: true, message: `已清除 ${date} 的結果${r.reclaimed ? `，收回 ${r.reclaimed} ESG 幣` : ''}`, ...r });
});

/** PUT /api/admin/users/:userId/binding  body: { studentId | studentAccount }（家長） */
const setBinding = handle('綁定學生', async (req, res) => {
  let studentId = req.body.studentId;
  if (!studentId) {
    const s = await findUserByIdentifier(req.body.studentAccount);
    if (!s) return bad(res, 404, '查無此學生帳號');
    studentId = s.id;
  }
  const r = await roster.bindParent(req.params.userId, studentId, req.user.uid);
  return res.status(200).json({ success: true, message: `已綁定 ${r.studentName}` });
});

/** DELETE /api/admin/users/:userId/binding（家長） */
const clearBinding = handle('解除綁定', async (req, res) => {
  await roster.bindParent(req.params.userId, null, req.user.uid);
  return res.status(200).json({ success: true, message: '已解除綁定' });
});

module.exports = {
  getOverview,
  listClasses,
  getClassDetail,
  createClass,
  updateClass,
  deleteClass,
  setTeacher,
  clearTeacher,
  setLunchLeader,
  clearLunchLeader,
  listUsers,
  getUserDetail,
  createUser,
  updateUser,
  deleteUser,
  adjustCoins,
  setPlate,
  clearPlate,
  setBinding,
  clearBinding,
  CREATABLE_ROLES,
  LEVEL_PCT,
};
