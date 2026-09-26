/**
 * 家長功能：每日簽到、查看孩子的午餐狀況。
 *
 * 簽到規則（使用者指定）：
 *  · 每位家長**每日一次**（doc id = `日期_家長id`，重複簽到不會重複發幣）
 *  · 獎勵 **+1 S幣記在綁定的學生帳上** —— 家長自己沒有幣系統
 *
 * 原版的問題：沒有每日限制（可無限累加紀錄）、沒有發幣、也沒有把簽到連到學生。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, ROLES, COIN_RULES } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { awardUser } = require('../lib/coins');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

async function loadBoundStudent(req) {
  const studentId = req.user.boundStudentId;
  if (!studentId) return null;
  const snap = await db.collection(COL.users).doc(studentId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * POST /api/parent/sign-in （相容路徑：POST /api/user/parent-sign-in）
 * 家長簽到 → 綁定學生 +1 S幣，每日一次。
 */
const parentSignIn = async (req, res) => {
  try {
    if (req.user.role !== ROLES.PARENT) {
      return bad(res, 403, '僅家長身份可簽到');
    }
    const student = await loadBoundStudent(req);
    if (!student) {
      return bad(res, 400, '此家長帳號尚未綁定學生，請重新註冊或聯絡老師');
    }

    const date = today();
    const ref = db.collection(COL.parentSignIns).doc(ids.parentSignIn(date, req.user.uid));
    const existing = await ref.get();

    if (existing.exists && existing.data().coinAwarded) {
      return res.status(200).json({
        success: true,
        alreadySignedIn: true,
        message: '今天已經簽到過了，明天再來關心孩子的午餐吧',
        date,
        student: { displayName: student.displayName, className: student.className },
        reward: { E: 0, S: 0 },
      });
    }

    const reward = await awardUser({
      userId: student.id,
      E: COIN_RULES.PARENT_SIGN_IN.E,
      S: COIN_RULES.PARENT_SIGN_IN.S,
      reason: `家長簽到（${req.user.displayName}）`,
      refType: 'parent_sign_in',
      refId: ids.parentSignIn(date, req.user.uid),
      date,
      role: student.role,
    });

    await ref.set({
      date,
      parentId: req.user.uid,
      parentName: req.user.displayName,
      studentId: student.id,
      studentName: student.displayName || '',
      classId: student.classId || null,
      schoolId: student.schoolId || null,
      coinAwarded: true,
      rewardToStudent: reward,
      signedInAt: serverTime(),
    }, { merge: true });

    return res.status(201).json({
      success: true,
      alreadySignedIn: false,
      message: `簽到成功！已為 ${student.displayName} 加 ${reward.S} 個 S幣`,
      date,
      student: { displayName: student.displayName, className: student.className },
      reward,
    });
  } catch (error) {
    console.error('家長簽到失敗:', error);
    return bad(res, error.status || 500, error.message || '家長簽到失敗');
  }
};

/**
 * GET /api/parent/child-status?range=week|month
 * 家長關心孩子午餐狀況：今天吃完了嗎、孩子的幣、今天全班剩了什麼、近期簽到與吃完紀錄。
 */
const getChildStatus = async (req, res) => {
  try {
    if (req.user.role !== ROLES.PARENT) return bad(res, 403, '僅家長身份可查看');
    const student = await loadBoundStudent(req);
    if (!student) return bad(res, 400, '此家長帳號尚未綁定學生');

    const date = isYmd(req.query.date) ? req.query.date : today();
    const days = String(req.query.range || 'week').includes('month') ? 30 : 7;
    const since = daysAgo(days - 1);

    const [checkSnap, historySnap, signInSnap, leftoverSnap] = await Promise.all([
      db.collection(COL.mealChecks).doc(ids.mealCheck(date, student.id)).get(),
      db.collection(COL.mealChecks)
        .where('studentId', '==', student.id)
        .orderBy('date', 'desc')
        .limit(days)
        .get(),
      db.collection(COL.parentSignIns)
        .where('studentId', '==', student.id)
        .orderBy('date', 'desc')
        .limit(days)
        .get(),
      student.classId
        ? db.collection(COL.dishLeftovers).where('classId', '==', student.classId).where('date', '==', date).get()
        : Promise.resolve({ docs: [] }),
    ]);

    const todayCheck = checkSnap.exists ? checkSnap.data() : null;
    const history = historySnap.docs.map((d) => d.data()).filter((c) => c.date >= since);
    const finishedDays = history.filter((c) => c.finished).length;

    // 今天全班各菜剩多少（讓家長知道孩子今天的午餐內容與全班狀況）
    const classDishes = leftoverSnap.docs.map((d) => {
      const x = d.data();
      return {
        dishName: x.dishName,
        category: x.category,
        remainingPct: Math.round(Number(x.remainingRatio || 0) * 100),
        leftoverG: Math.round(Number(x.leftoverG || 0)),
      };
    });

    return res.status(200).json({
      success: true,
      date,
      child: {
        displayName: student.displayName,
        grade: student.grade,
        className: student.className,
        seatNo: student.seatNo,
        coins: { E: Number(student.eCoin || 0), S: Number(student.sCoin || 0) },
      },
      todayFinished: todayCheck ? Boolean(todayCheck.finished) : null, // null = 老師還沒勾
      todayCheckedAt: todayCheck && todayCheck.checkedAt ? todayCheck.checkedAt.toDate().toISOString() : null,
      classDishesToday: classDishes,
      stats: {
        range: `${days}d`,
        recordedDays: history.length,
        finishedDays,
        finishedRate: history.length ? Math.round((finishedDays / history.length) * 100) : 0,
        mySignIns: signInSnap.docs.filter((d) => d.data().date >= since).length,
      },
      recentChecks: history.map((c) => ({ date: c.date, finished: Boolean(c.finished) })),
      signedInToday: signInSnap.docs.some((d) => d.data().date === date && d.data().parentId === req.user.uid),
    });
  } catch (error) {
    console.error('取得孩子狀況失敗:', error);
    return bad(res, error.status || 500, error.message || '取得孩子狀況失敗');
  }
};

module.exports = { parentSignIn, getChildStatus };
