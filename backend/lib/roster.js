/**
 * 名冊的一致性：班級代號、班名顯示，以及「兩邊都要改」的寫入。
 *
 * ## 哪些資料存了兩份
 *
 *   班級 ↔ 學生    users.grade / className / schoolId 是 classes 的副本（顯示與註冊比對用）
 *   班級 ↔ 導師    classes.teacherUserId ↔ 導師的 users.classId
 *   班級 ↔ 午餐長  classes.lunchLeaderUserId（學生的角色不變，見 middleware/auth.js）
 *   家長 ↔ 學生    家長 users.boundStudentId ↔ 學生 users.parentUserId（一位學生一位家長）
 *   班級 ↔ 秤      devices.className 是副本
 *
 * 以前這些各自在不同的 controller 裡改，常常只改到一邊（例如改班名，學生身上的
 * className 還是舊的，註冊比對就對不上）。現在凡是會動到兩邊的寫入都走這裡，
 * 用 batch / transaction 一起寫；寫漏的舊資料由「資料檢查」找出來修（lib/consistency.js）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ROLES } = require('../config/schema');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (status, message) => Object.assign(new Error(message), { status });
const norm = (v) => String(v == null ? '' : v).trim();

// ── 班級代號與顯示 ─────────────────────────────────────────────────

/**
 * 班級的顯示名稱。
 * 班名已經含年級（3 年級的「302」）就直接叫「302 班」，不要變成「3 年 302 班」。
 */
function classLabel(grade, name) {
  const g = norm(grade);
  const n = norm(name);
  if (/^\d+$/.test(n) && n.length >= 3 && g && n.startsWith(g)) return `${n} 班`;
  return g ? `${g} 年 ${n} 班` : `${n} 班`;
}

/**
 * 依年級與班名決定 classId。
 *
 *   年級 3、班名 302 → cls-302   （班名已經含年級，不要再接一次變成 cls-3302）
 *   年級 3、班名 2   → cls-302   （只給班號就補成三碼）
 *   年級 3、班名 忠  → null       （非數字班名交給 Firestore 自動編號）
 *
 * 數字班名的開頭跟年級對不上（年級 3、班名 202）多半是打錯，直接退回。
 * @returns {{ classId: string|null, error?: string }}
 */
function classIdFor(grade, name) {
  const g = norm(grade);
  const n = norm(name);
  if (!/^\d+$/.test(n)) {
    const slug = n.replace(/[^\w-]/g, '');
    return { classId: slug && /^\d+$/.test(g) ? `cls-${g}-${slug}` : null };
  }
  if (n.length >= 3) {
    if (g && !n.startsWith(g)) {
      return { classId: null, error: `班級名稱「${n}」的開頭不是 ${g}，跟年級對不上（例如 3 年級是 301、302…）` };
    }
    return { classId: `cls-${n}` };
  }
  if (!/^\d+$/.test(g)) return { classId: null };
  return { classId: `cls-${g}${n.padStart(2, '0')}` };
}

// ── 批次寫入（Firestore 一個 batch 最多 500 筆）────────────────────
async function commitInChunks(writes, size = 450) {
  for (let i = 0; i < writes.length; i += size) {
    const batch = db.batch();
    writes.slice(i, i + size).forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }
  return writes.length;
}

/**
 * 班級改了年級／班名之後，把副本同步到班上所有人與綁定的秤。
 * @returns {Promise<{users:number, devices:number}>}
 */
async function syncClassCopies(classId) {
  const snap = await db.collection(COL.classes).doc(classId).get();
  if (!snap.exists) return { users: 0, devices: 0 };
  const c = snap.data();
  const [usersSnap, devicesSnap] = await Promise.all([
    db.collection(COL.users).where('classId', '==', classId).get(),
    db.collection(COL.devices).where('classId', '==', classId).get(),
  ]);
  const want = { grade: c.grade || null, className: c.name || null, schoolId: c.schoolId || null };
  const userWrites = usersSnap.docs
    .filter((d) => d.data().role !== ROLES.ADMIN)            // 管理員的 classId 只是預設班級
    .filter((d) => Object.keys(want).some((k) => (d.data()[k] || null) !== want[k]))
    .map((d) => ({ ref: d.ref, data: want }));
  const deviceWrites = devicesSnap.docs
    .filter((d) => (d.data().className || null) !== want.className)
    .map((d) => ({ ref: d.ref, data: { className: want.className } }));
  await commitInChunks([...userWrites, ...deviceWrites]);
  return { users: userWrites.length, devices: deviceWrites.length };
}

// ── 導師 ──────────────────────────────────────────────────────────

/**
 * 指定（或清除）某班的導師。一位老師只當一個班的導師：
 * 他原本帶的班級指標會一起清掉，他的 classId 也改成新班級。
 * 前一位導師的 classId 不動（他仍可看這個班，例如協同老師），只是不再是導師。
 */
async function setHomeroom(classId, teacherId, by) {
  const classRef = db.collection(COL.classes).doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) throw fail(404, '查無此班級');
  const c = classSnap.data();

  const batch = db.batch();
  if (!teacherId) {
    batch.set(classRef, { teacherUserId: null, updatedBy: by, updatedAt: serverTime() }, { merge: true });
    await batch.commit();
    return { teacher: null };
  }

  const tSnap = await db.collection(COL.users).doc(teacherId).get();
  if (!tSnap.exists) throw fail(404, '查無此使用者');
  const t = tSnap.data();
  if (t.role !== ROLES.TEACHER) throw fail(400, '只能指定老師擔任導師');

  const others = await db.collection(COL.classes).where('teacherUserId', '==', teacherId).get();
  others.docs.filter((d) => d.id !== classId)
    .forEach((d) => batch.set(d.ref, { teacherUserId: null, updatedAt: serverTime() }, { merge: true }));
  batch.set(classRef, { teacherUserId: teacherId, updatedBy: by, updatedAt: serverTime() }, { merge: true });
  batch.set(tSnap.ref, {
    classId, grade: c.grade || null, className: c.name || null, schoolId: c.schoolId || null,
    updatedBy: by, updatedAt: serverTime(),
  }, { merge: true });
  await batch.commit();
  return { teacher: { userId: teacherId, displayName: t.displayName || '' } };
}

// ── 午餐長 ────────────────────────────────────────────────────────

async function setLunchLeader(classId, studentId, by) {
  const classRef = db.collection(COL.classes).doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) throw fail(404, '查無此班級');
  if (studentId) {
    const s = await db.collection(COL.users).doc(studentId).get();
    if (!s.exists) throw fail(404, '查無此使用者');
    if (s.data().role !== ROLES.STUDENT) throw fail(400, '只能指派學生擔任午餐長');
    if (s.data().classId !== classId) throw fail(400, '該學生不屬於這個班級');
  }
  const previous = classSnap.data().lunchLeaderUserId || null;
  await classRef.set({ lunchLeaderUserId: studentId || null, updatedBy: by, updatedAt: serverTime() }, { merge: true });
  return { previous };
}

// ── 家長 ↔ 學生 ────────────────────────────────────────────────────

/**
 * 綁定（或解除，studentId = null）家長與學生。兩邊在同一個 transaction 裡改：
 *   · 家長原本綁的學生，那邊的 parentUserId 清掉
 *   · 新學生若已經有別的家長 → 拒絕（一位學生一位家長，與註冊的規則一致）
 */
async function bindParent(parentId, studentId, by) {
  const parentRef = db.collection(COL.users).doc(parentId);
  return db.runTransaction(async (tx) => {
    const pSnap = await tx.get(parentRef);
    if (!pSnap.exists) throw fail(404, '查無此家長');
    const p = pSnap.data();
    if (p.role !== ROLES.PARENT) throw fail(400, '這個帳號不是家長');

    const oldId = p.boundStudentId || null;
    const oldSnap = oldId && oldId !== studentId ? await tx.get(db.collection(COL.users).doc(oldId)) : null;
    let student = null;
    let sRef = null;
    if (studentId) {
      sRef = db.collection(COL.users).doc(studentId);
      const sSnap = await tx.get(sRef);
      if (!sSnap.exists) throw fail(404, '查無此學生');
      student = sSnap.data();
      if (student.role !== ROLES.STUDENT) throw fail(400, '綁定的帳號必須是學生');
      if (student.parentUserId && student.parentUserId !== parentId) {
        throw fail(409, `${student.displayName || '這位學生'} 已經綁定其他家長，請先解除那邊的綁定`);
      }
    }

    if (oldSnap && oldSnap.exists && oldSnap.data().parentUserId === parentId) {
      tx.set(oldSnap.ref, { parentUserId: null, parentName: admin.firestore.FieldValue.delete() }, { merge: true });
    }
    tx.set(parentRef, {
      boundStudentId: studentId || null,
      // 舊版存的學生資料快照會過期，不再保留；要學生資料就讀學生本人
      studentBinding: admin.firestore.FieldValue.delete(),
      schoolId: student ? student.schoolId || null : p.schoolId || null,
      updatedBy: by || null,
      updatedAt: serverTime(),
    }, { merge: true });
    if (sRef) tx.set(sRef, { parentUserId: parentId, parentName: admin.firestore.FieldValue.delete() }, { merge: true });
    return { studentId: studentId || null, studentName: student ? student.displayName || '' : null };
  });
}

module.exports = {
  norm,
  classLabel,
  classIdFor,
  commitInChunks,
  syncClassCopies,
  setHomeroom,
  setLunchLeader,
  bindParent,
};
