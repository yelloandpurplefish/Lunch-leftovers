/**
 * 教師每日逐生檢查「是否吃完他的部分」。
 *
 * 這個動作就是規則裡的「吃完一餐」：勾選 → 該學生 ESG 幣
 * 營養 +1、減碳 +1、感謝 +G（每人每日一次）。
 * 感謝的額度由管理員面板調整（gratitude.mealFinishedG，預設 5），
 * 因為它不是算出來的，而是「老師看見你吃完了」這件事的份量，屬於學校政策。
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
const { getSettings } = require('../lib/settings');
const { targetClassId } = require('../middleware/auth');

/** 某筆檢查紀錄當初發出了多少 ESG（各來源）。沖銷要用當初的額度，不是現在的設定。 */
function awardedOf(prev) {
  const a = (prev && prev.awardedESG) || {};
  return { E: Number(a.E || 0), S: Number(a.S || 0), G: Number(a.G || 0) };
}

/**
 * 這一餐的發幣額度：E/S 來自 COIN_RULES（固定），G 來自可調參數。
 * 每次請求都讀一次；settings 自己有 60 秒快取，不會每次都打資料庫。
 */
async function finishedReward() {
  const s = await getSettings();
  const g = Number((s.gratitude || {}).mealFinishedG || 0);
  return {
    E: COIN_RULES.MEAL_FINISHED.E,
    S: COIN_RULES.MEAL_FINISHED.S,
    G: Number.isFinite(g) && g > 0 ? g : 0,
  };
}

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/**
 * 班上的學生，依座號排序。
 * 教師只能操作自己的班、管理員可用 classId 指定（middleware/auth.js 的 targetClassId）。
 * @param {string|null} leaderId 班級的 lunchLeaderUserId，用來在名冊上標出午餐長
 */
async function getRoster(classId, leaderId = null) {
  const snap = await db.collection(COL.users)
    .where('classId', '==', classId)
    .where('role', '==', ROLES.STUDENT)
    .get();
  return snap.docs
    .map((d) => ({
      studentId: d.id,
      displayName: d.data().displayName || '',
      seatNo: d.data().seatNo || '',
      role: d.data().role,
      isLunchLeader: Boolean(leaderId) && d.id === leaderId,
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

    const classSnap = await db.collection(COL.classes).doc(classId).get();
    const leaderId = classSnap.exists ? classSnap.data().lunchLeaderUserId || null : null;
    const [roster, checks] = await Promise.all([
      getRoster(classId, leaderId),
      getChecks(classId, date),
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
      rewardPerStudent: await finishedReward(),
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

    let coinDelta = { E: 0, S: 0, G: 0 };
    let coinsAwarded = prev ? Boolean(prev.coinsAwarded) : false;
    const reward = await finishedReward();

    if (finished && !coinsAwarded) {
      // 吃完一餐 → 個人 +1 E、+1 S、+G（感謝）
      coinDelta = await awardUser({
        userId: studentId,
        E: reward.E,
        S: reward.S,
        G: reward.G,
        reason: '吃完一餐（老師確認）',
        refType: 'meal_check',
        refId: ids.mealCheck(date, studentId),
        date,
        role: student.role,
      });
      coinsAwarded = true;
    } else if (!finished && coinsAwarded) {
      // 沖銷用「當初發出的額度」而不是當下的設定值——
      // 面板若在中途調了額度，用新值沖銷會多扣或少扣。
      const back = awardedOf(prev);
      const reversed = await reverseAward({
        userId: studentId,
        E: back.E,
        S: back.S,
        G: back.G,
        reason: '取消「吃完一餐」勾選',
        refType: 'meal_check',
        refId: ids.mealCheck(date, studentId),
        date,
      });
      coinDelta = { E: -reversed.E, S: -reversed.S, G: -reversed.G, total: -reversed.total };
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
      // 發出多少要留存（各來源，單位 ESG），取消勾選時才沖銷得準
      awardedESG: coinsAwarded ? { E: reward.E, S: reward.S, G: reward.G } : null,
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
    const reward = await finishedReward();
    for (const r of targets) {
      const prev = checks.get(r.studentId);
      if (prev && prev.coinsAwarded) continue; // 已發過就跳過，不重複
      await awardUser({
        userId: r.studentId,
        E: reward.E,
        S: reward.S,
        G: reward.G,
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
        awardedESG: { E: reward.E, S: reward.S, G: reward.G },
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
      rewardPerStudent: reward,
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
      // 讓前端的說明文字能顯示實際額度（感謝的額度可在管理員面板調整）
      rewardPerStudent: await finishedReward(),
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
