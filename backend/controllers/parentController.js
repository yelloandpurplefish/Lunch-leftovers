/**
 * 家長功能：每日簽到、查看孩子的午餐狀況。
 *
 * 簽到規則（使用者指定）：
 *  · 每位家長**每日一次**（doc id = `日期_家長id`，重複簽到不會重複發幣）
 *  · 獎勵 **+1 ESG 幣記在綁定的學生帳上** —— 家長自己沒有幣系統
 *
 * 孩子「今天吃得怎麼樣」以孩子拍的餐盤結果為準（見 plateController）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, ROLES, COIN_RULES } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { applyInTx } = require('../lib/coins');
const plates = require('../lib/plates');
const { recentOf, summarizeRecent } = require('./plateController');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

async function loadBoundStudent(req) {
  const studentId = req.user.boundStudentId;
  if (!studentId) return null;
  const snap = await db.collection(COL.users).doc(studentId).get();
  if (!snap.exists || snap.data().role !== ROLES.STUDENT) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * 評論的長度限制。
 *
 * 下限不是刁難，是為了讓這個欄位真的有內容——沒有下限的話，
 * 想快點拿幣的人會直接打一個句號。上限則是避免有人把整篇文章貼進資料庫。
 */
const COMMENT_MIN = 5;
const COMMENT_MAX = 200;

/** 清掉前後空白與連續空白行，再判斷長度。 */
function normalizeComment(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

/** POST /api/parent/sign-in — 家長簽到 → 綁定學生 +1 ESG 幣，每日一次。 */
const parentSignIn = async (req, res) => {
  try {
    if (req.user.role !== ROLES.PARENT) {
      return bad(res, 403, '僅家長身份可簽到');
    }

    // 先擋評論再查資料庫：驗證失敗就不必白跑一次查詢
    const comment = normalizeComment(req.body && req.body.comment);
    if (!comment) {
      return bad(res, 400, '請先寫下今天想對孩子午餐說的話，才能完成簽到');
    }
    if (comment.length < COMMENT_MIN) {
      return bad(res, 400, `評論太短了，請至少寫 ${COMMENT_MIN} 個字`);
    }
    if (comment.length > COMMENT_MAX) {
      return bad(res, 400, `評論請控制在 ${COMMENT_MAX} 字以內（目前 ${comment.length} 字）`);
    }

    const student = await loadBoundStudent(req);
    if (!student) {
      return bad(res, 400, '此家長帳號尚未綁定學生，請重新註冊或聯絡老師');
    }

    const date = today();
    const ref = db.collection(COL.parentSignIns).doc(ids.parentSignIn(date, req.user.uid));
    const studentRef = db.collection(COL.users).doc(student.id);

    // 簽到紀錄與發幣在同一個 transaction：兩個分頁同時按也只會有一筆成功，
    // 也不會出現「有簽到紀錄但幣沒發」或反過來的情況
    const result = await db.runTransaction(async (tx) => {
      const [existing, studentSnap] = await Promise.all([tx.get(ref), tx.get(studentRef)]);
      if (existing.exists) return { already: true, comment: existing.data().comment || null };
      const reward = applyInTx(tx, {
        userRef: studentRef,
        user: studentSnap.data(),
        delta: COIN_RULES.PARENT_SIGN_IN,
        source: 'parent',
        reason: `家長簽到（${req.user.displayName}）`,
        refType: 'parent_sign_in',
        refId: ref.id,
        date,
      });
      tx.set(ref, {
        date,
        parentId: req.user.uid,
        parentName: req.user.displayName,
        studentId: student.id,
        studentName: student.displayName || '',
        classId: student.classId || null,
        schoolId: student.schoolId || null,
        comment,
        commentAt: serverTime(),
        coinAwarded: reward > 0,
        rewardToStudent: reward,
        signedInAt: serverTime(),
      });
      return { already: false, reward };
    });

    if (result.already) {
      return res.status(200).json({
        success: true,
        alreadySignedIn: true,
        message: '今天已經簽到過了，明天再來關心孩子的午餐吧',
        date,
        student: { displayName: student.displayName, className: student.className },
        comment: result.comment,
        reward: 0,
      });
    }
    const { reward } = result;

    return res.status(201).json({
      success: true,
      alreadySignedIn: false,
      message: `簽到成功！已為 ${student.displayName} 加 ${reward} 個 ESG 幣`,
      date,
      student: { displayName: student.displayName, className: student.className },
      comment,
      reward,
    });
  } catch (error) {
    console.error('家長簽到失敗:', error);
    return bad(res, error.status || 500, error.message || '家長簽到失敗');
  }
};

/**
 * GET /api/parent/child-status?range=week|month
 * 家長關心孩子午餐狀況：今天的餐盤結果、孩子的幣、今天全班剩了什麼、近期紀錄與簽到。
 */
const getChildStatus = async (req, res) => {
  try {
    if (req.user.role !== ROLES.PARENT) return bad(res, 403, '僅家長身份可查看');
    const student = await loadBoundStudent(req);
    if (!student) return bad(res, 400, '此家長帳號尚未綁定學生');

    const date = isYmd(req.query.date) ? req.query.date : today();
    const days = String(req.query.range || 'week').includes('month') ? 30 : 7;
    const since = daysAgo(days - 1);

    const [todaySnap, recent, signInSnap, leftoverSnap] = await Promise.all([
      plates.scanRef(student.id, date).get(),
      recentOf(student.id, days),
      db.collection(COL.parentSignIns)
        .where('studentId', '==', student.id)
        .orderBy('date', 'desc')
        .limit(days)
        .get(),
      student.classId
        ? db.collection(COL.dishLeftovers).where('classId', '==', student.classId).where('date', '==', date).get()
        : Promise.resolve({ docs: [] }),
    ]);

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
        coins: { ESG: Number(student.esgCoin || 0) },
      },
      todayPlate: todaySnap.exists ? plates.present(todaySnap.id, todaySnap.data()) : null,
      recentPlates: recent,
      classDishesToday: classDishes,
      stats: {
        range: `${days}d`,
        ...summarizeRecent(recent, days),
        mySignIns: signInSnap.docs.filter((d) => d.data().date >= since && d.data().parentId === req.user.uid).length,
      },
      signedInToday: signInSnap.docs.some((d) => d.data().date === date && d.data().parentId === req.user.uid),
    });
  } catch (error) {
    console.error('取得孩子狀況失敗:', error);
    return bad(res, error.status || 500, error.message || '取得孩子狀況失敗');
  }
};

module.exports = { parentSignIn, getChildStatus };
