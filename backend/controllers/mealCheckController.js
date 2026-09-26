/**
 * 教師每日逐生檢查「是否吃完他的部分」。
 *
 * 這個動作就是規則裡的「吃完一餐」：勾選 → 該學生 +1 E幣、+1 S幣（每人每日一次）。
 * 以 `meal_checks/{日期_學生id}` 為決定性 doc id，重複勾選不會重複發幣；
 * 取消勾選會沖銷當日這筆（在餘額 0 處夾住，見 lib/coins.js reverseAward）。
 *
 * 清單是即時的：每次勾選都立刻回寫伺服器，並回傳更新後的統計，
 * 前端不需要再拉一次整份名冊。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, ROLES, COIN_RULES, COIN_HOLDER_ROLES } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { awardUser, reverseAward } = require('../lib/coins');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/** 教師只能操作自己的班；管理員可用 classId 指定。*/
function targetClassId(req) {
  const asked = String(req.query.classId || req.body.classId || '');
  if (req.user.role === ROLES.ADMIN) return asked || req.user.classId || '';
  if (asked && asked !== req.user.classId) return null; // 越權
  return req.user.classId || '';
}

/** 班上持幣成員（學生與午餐長），依座號排序。*/
async function getRoster(classId) {
  const snap = await db.collection(COL.users)
    .where('classId', '==', classId)
    .where('role', 'in', COIN_HOLDER_ROLES)
    .get();
  return snap.docs
    .map((d) => ({
      studentId: d.id,
      displayName: d.data().displayName || '',
      seatNo: d.data().seatNo || '',
      role: d.data().role,
      account: d.data().account || null,
    }))
    .sort((a, b) => String(a.seatNo).localeCompare(String(b.seatNo), 'zh-Hant', { numeric: true }));
}

async function getChecks(classId, date) {
  const snap = await db.collection(COL.mealChecks)
    .where('classId', '==', classId)
    .where('date', '==', date)
    .get();
  const map = new Map();
  snap.docs.forEach((d) => map.set(d.data().studentId, d.data()));
  return map;
}

function buildSummary(rows) {
  const finished = rows.filter((r) => r.finished).length;
  const checked = rows.filter((r) => r.checkedAt).length;
  return {
    total: rows.length,
    finished,
    notFinished: checked - finished,
    unchecked: rows.length - checked,
    finishedRate: rows.length ? Math.round((finished / rows.length) * 100) : 0,
  };
}

/**
 * GET /api/meal-check/roster?date=&classId=
 * 教師頁主清單：班上每位學生今天是否吃完。
 */
const getRoster_ = async (req, res) => {
  try {
    const classId = targetClassId(req);
    if (classId === null) return bad(res, 403, '只能檢查自己班級的學生');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.query.date) ? req.query.date : today();

    const [roster, checks, classSnap] = await Promise.all([
      getRoster(classId),
      getChecks(classId, date),
      db.collection(COL.classes).doc(classId).get(),
    ]);

    const rows = roster.map((r) => {
      const c = checks.get(r.studentId);
      return {
        ...r,
        finished: c ? Boolean(c.finished) : false,
        checkedAt: c && c.checkedAt ? c.checkedAt.toDate().toISOString() : null,
        coinsAwarded: c ? Boolean(c.coinsAwarded) : false,
      };
    });

    return res.status(200).json({
      success: true,
      date,
      classId,
      className: classSnap.exists ? classSnap.data().name : null,
      rewardPerStudent: COIN_RULES.MEAL_FINISHED,
      rows,
      summary: buildSummary(rows),
    });
  } catch (error) {
    console.error('取得檢查清單失敗:', error);
    return bad(res, 500, error.message || '取得檢查清單失敗');
  }
};

/**
 * POST /api/meal-check/toggle
 * body: { studentId, finished, date? }
 * 勾選＝吃完一餐（發幣）；取消＝沖銷當日這筆。
 */
const toggleCheck = async (req, res) => {
  try {
    const classId = targetClassId(req);
    if (classId === null) return bad(res, 403, '只能檢查自己班級的學生');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');

    const studentId = String(req.body.studentId || '');
    const finished = Boolean(req.body.finished);
    const date = isYmd(req.body.date) ? req.body.date : today();
    if (!studentId) return bad(res, 400, '請指定學生');
    // 只能勾選當天或過去，不可預先勾選未來
    if (date > today()) return bad(res, 400, '不可勾選未來日期');

    const studentSnap = await db.collection(COL.users).doc(studentId).get();
    if (!studentSnap.exists) return bad(res, 404, '查無此學生');
    const student = studentSnap.data();
    if (student.classId !== classId) return bad(res, 403, '該學生不屬於這個班級');
    if (!COIN_HOLDER_ROLES.includes(student.role)) return bad(res, 400, '此帳號不是學生');

    const ref = db.collection(COL.mealChecks).doc(ids.mealCheck(date, studentId));
    const existing = await ref.get();
    const prev = existing.exists ? existing.data() : null;

    let coinDelta = { E: 0, S: 0 };
    let coinsAwarded = prev ? Boolean(prev.coinsAwarded) : false;

    if (finished && !coinsAwarded) {
      // 吃完一餐 → 個人 +1 E、+1 S
      coinDelta = await awardUser({
        userId: studentId,
        E: COIN_RULES.MEAL_FINISHED.E,
        S: COIN_RULES.MEAL_FINISHED.S,
        reason: '吃完一餐（老師確認）',
        refType: 'meal_check',
        refId: ids.mealCheck(date, studentId),
        date,
        role: student.role,
      });
      coinsAwarded = true;
    } else if (!finished && coinsAwarded) {
      const reversed = await reverseAward({
        userId: studentId,
        E: COIN_RULES.MEAL_FINISHED.E,
        S: COIN_RULES.MEAL_FINISHED.S,
        reason: '取消「吃完一餐」勾選',
        refType: 'meal_check',
        refId: ids.mealCheck(date, studentId),
        date,
      });
      coinDelta = { E: -reversed.E, S: -reversed.S };
      coinsAwarded = false;
    }

    await ref.set({
      date,
      studentId,
      studentName: student.displayName || '',
      seatNo: student.seatNo || '',
      classId,
      schoolId: student.schoolId || null,
      finished,
      coinsAwarded,
      checkedBy: req.user.uid,
      checkedByName: req.user.displayName,
      checkedAt: serverTime(),
    }, { merge: true });

    // 回傳更新後的統計，前端即時更新計數不必重抓名冊
    const [roster, checks] = await Promise.all([getRoster(classId), getChecks(classId, date)]);
    const rows = roster.map((r) => {
      const c = checks.get(r.studentId);
      return { ...r, finished: c ? Boolean(c.finished) : false, checkedAt: c && c.checkedAt ? true : null };
    });

    return res.status(200).json({
      success: true,
      message: finished ? '已記錄吃完一餐' : '已取消勾選',
      studentId,
      finished,
      coinDelta,
      summary: buildSummary(rows),
    });
  } catch (error) {
    console.error('勾選失敗:', error);
    return bad(res, error.status || 500, error.message || '勾選失敗');
  }
};

/**
 * POST /api/meal-check/finish-all
 * body: { date?, studentIds? } —— 一次把清單上（或指定的）學生標記吃完。
 * 教師頁常見操作：先全部勾選，再取消少數沒吃完的。
 */
const finishAll = async (req, res) => {
  try {
    const classId = targetClassId(req);
    if (classId === null) return bad(res, 403, '只能檢查自己班級的學生');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.body.date) ? req.body.date : today();
    if (date > today()) return bad(res, 400, '不可勾選未來日期');

    const roster = await getRoster(classId);
    const only = Array.isArray(req.body.studentIds) && req.body.studentIds.length
      ? new Set(req.body.studentIds.map(String))
      : null;
    const targets = only ? roster.filter((r) => only.has(r.studentId)) : roster;
    const checks = await getChecks(classId, date);

    let awardedCount = 0;
    for (const r of targets) {
      const prev = checks.get(r.studentId);
      if (prev && prev.coinsAwarded) continue; // 已發過就跳過，不重複
      await awardUser({
        userId: r.studentId,
        E: COIN_RULES.MEAL_FINISHED.E,
        S: COIN_RULES.MEAL_FINISHED.S,
        reason: '吃完一餐（老師確認）',
        refType: 'meal_check',
        refId: ids.mealCheck(date, r.studentId),
        date,
        role: r.role,
      });
      await db.collection(COL.mealChecks).doc(ids.mealCheck(date, r.studentId)).set({
        date,
        studentId: r.studentId,
        studentName: r.displayName,
        seatNo: r.seatNo,
        classId,
        finished: true,
        coinsAwarded: true,
        checkedBy: req.user.uid,
        checkedByName: req.user.displayName,
        checkedAt: serverTime(),
      }, { merge: true });
      awardedCount += 1;
    }

    const after = await getChecks(classId, date);
    const rows = roster.map((r) => ({ ...r, finished: after.has(r.studentId) ? Boolean(after.get(r.studentId).finished) : false, checkedAt: after.has(r.studentId) ? true : null }));

    return res.status(200).json({
      success: true,
      message: `已標記 ${awardedCount} 位學生吃完一餐`,
      awarded: awardedCount,
      summary: buildSummary(rows),
    });
  } catch (error) {
    console.error('批次勾選失敗:', error);
    return bad(res, error.status || 500, error.message || '批次勾選失敗');
  }
};

/**
 * GET /api/meal-check/mine?range=week|month
 * 學生看自己的吃完紀錄；家長看綁定孩子的紀錄（供「關心小孩午餐狀況」）。
 */
const getMyChecks = async (req, res) => {
  try {
    const studentId = req.user.role === ROLES.PARENT ? req.user.boundStudentId : req.user.uid;
    if (!studentId) return bad(res, 400, '尚未綁定學生');

    const days = String(req.query.range || 'week').includes('month') ? 30 : 7;
    const since = daysAgo(days - 1);

    const snap = await db.collection(COL.mealChecks)
      .where('studentId', '==', studentId)
      .orderBy('date', 'desc')
      .limit(days)
      .get();

    const records = snap.docs
      .map((d) => d.data())
      .filter((c) => c.date >= since)
      .map((c) => ({
        date: c.date,
        finished: Boolean(c.finished),
        checkedByName: c.checkedByName || null,
        checkedAt: c.checkedAt ? c.checkedAt.toDate().toISOString() : null,
      }));

    const finishedDays = records.filter((r) => r.finished).length;
    return res.status(200).json({
      success: true,
      studentId,
      range: `${days}d`,
      records,
      stats: { days: records.length, finishedDays, rate: records.length ? Math.round((finishedDays / records.length) * 100) : 0 },
    });
  } catch (error) {
    console.error('取得吃完紀錄失敗:', error);
    return bad(res, 500, error.message || '取得吃完紀錄失敗');
  }
};

module.exports = {
  getRoster: getRoster_,
  toggleCheck,
  finishAll,
  getMyChecks,
};
