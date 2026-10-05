/**
 * 跨班支援：細到「每班每個菜品」的剩餘量。
 *
 * 規則（使用者指定，已於此版改變）：
 *   **每道菜一律附上其他班的狀況**，不再等本班低於門檻才顯示。
 *   原本的設計是「沒有需求就不顯示」，改為常態顯示的理由是：
 *   午餐長在記錄當下就需要知道「這道菜別班還有沒有」才能決定去拿或提供，
 *   等到跌破門檻才出現已經來不及——那時菜多半也被其他班拿走了。
 *
 * 門檻仍在 config/schema.js 的 SUPPORT，但**只用於標示，不再過濾資料**：
 *   shortageRatio  本班剩餘比低於此值 → 標為 shortage（UI 強調「本班快沒了」）
 *   minOfferGrams  別班剩餘低於此值 → canOffer=false（UI 標為「只剩一點」）
 *
 * 查詢方式：**整間學校當日只查一次**，再於記憶體依 dishId 分組。
 * 常態顯示若沿用「每道菜查一次」會變成每次請求 6 次查詢；
 * 單次查詢反而比舊版（只查缺貨的菜）更省，而且用的是同一個既有索引
 * （schoolId + date 是 dish_leftovers 索引的前綴）。
 *
 * 資料來源是 dish_leftovers（午餐長每次辨識/微調就即時更新），所以是當餐即時狀況。
 * 本功能只提供資訊，不發幣（個人發幣只有「吃完一餐」與「家長簽到」兩項）。
 */
const { db } = require('../config/firebase');
const { COL, SUPPORT } = require('../config/schema');
const { today, isYmd } = require('../lib/dates');

const bad = (res, status, message) => res.status(status).json({ success: false, message });

function ratioOf(row) {
  const supplied = Number(row.suppliedG || 0);
  if (supplied <= 0) return 0;
  return Number(row.leftoverG || 0) / supplied;
}

/**
 * 把別班的剩餘量列轉成回應格式。
 *
 * `shortage` 是**該班自己**是否也低於門檻；`canOffer` 是剩餘量是否值得跑一趟。
 * 兩者都不過濾資料，只是讓 UI 能區分「可以去拿」與「他們也快沒了」——
 * 不然會發生「跑去別班才發現人家只剩一點」的白跑。
 */
function toOffer(o) {
  const ratio = ratioOf(o);
  const leftoverG = Math.round(Number(o.leftoverG || 0));
  return {
    classId: o.classId,
    className: o.className,
    grade: o.grade,
    leftoverG,
    remainingPct: Math.round(ratio * 100),
    shortage: ratio < SUPPORT.shortageRatio,
    canOffer: leftoverG >= SUPPORT.minOfferGrams,
    updatedAt: o.updatedAt && typeof o.updatedAt.toMillis === 'function'
      ? o.updatedAt.toMillis() : null,
  };
}

/**
 * 整間學校當日的剩餘量，依 dishId 分組。
 * 一次查完再分組，避免「每道菜查一次」。
 */
async function schoolDishesByDish(schoolId, date) {
  const byDish = new Map();
  if (!schoolId) return byDish;
  const snap = await db.collection(COL.dishLeftovers)
    .where('schoolId', '==', schoolId)
    .where('date', '==', date)
    .get();
  snap.docs.forEach((d) => {
    const row = d.data();
    if (!row.dishId) return;
    if (!byDish.has(row.dishId)) byDish.set(row.dishId, []);
    byDish.get(row.dishId).push(row);
  });
  return byDish;
}

/**
 * GET /api/support/dishes?date=
 * 本班今天各菜品剩餘量，**每道菜都附上其他班的狀況**。
 */
const getDishStatus = async (req, res) => {
  try {
    const classId = String(req.query.classId || req.user.classId || '');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.query.date) ? req.query.date : today();

    const mineSnap = await db.collection(COL.dishLeftovers)
      .where('classId', '==', classId)
      .where('date', '==', date)
      .get();

    if (mineSnap.empty) {
      return res.status(200).json({
        success: true,
        date,
        classId,
        threshold: SUPPORT,
        dishes: [],
        generatedAt: Date.now(),
        message: '今天還沒有紀錄，午餐長完成辨識後才會顯示各菜品剩餘量',
      });
    }

    const mine = mineSnap.docs.map((d) => d.data());
    const schoolId = mine[0].schoolId || null;
    const byDish = await schoolDishesByDish(schoolId, date);

    const dishes = mine.map((row) => {
      const ratio = ratioOf(row);
      // 剩餘量多的排前面，午餐長一眼就知道該去哪一班
      const others = (byDish.get(row.dishId) || [])
        .filter((o) => o.classId !== classId)
        .map(toOffer)
        .sort((a, b) => b.leftoverG - a.leftoverG)
        .slice(0, 10);

      return {
        slot: row.slot,
        dishId: row.dishId,
        dishName: row.dishName,
        category: row.category,
        suppliedG: Math.round(Number(row.suppliedG || 0)),
        leftoverG: Math.round(Number(row.leftoverG || 0)),
        remainingPct: Math.round(ratio * 100),
        shortage: ratio < SUPPORT.shortageRatio,
        otherClasses: others,
        // 有幾個班真的拿得出來（≥ minOfferGrams），UI 用來決定要不要強調
        offerCount: others.filter((o) => o.canOffer).length,
      };
    });

    const shortages = dishes.filter((d) => d.shortage);
    return res.status(200).json({
      success: true,
      date,
      classId,
      threshold: {
        shortagePct: Math.round(SUPPORT.shortageRatio * 100),
        minOfferGrams: SUPPORT.minOfferGrams,
      },
      dishes,
      // 前端據此顯示「資料截至幾點幾分」。跨班資料會隨其他班陸續記錄而變動，
      // 使用者必須知道手上這份是什麼時候的，否則容易誤判別班還有沒有。
      generatedAt: Date.now(),
      summary: {
        total: dishes.length,
        shortages: shortages.length,
        // 本班缺貨且真的有班級拿得出來
        withHelp: shortages.filter((d) => d.offerCount > 0).length,
        // 本班缺貨但目前沒人能支援 → 前端會繼續輪詢等別班記錄
        awaitingHelp: shortages.filter((d) => d.offerCount === 0).length,
        // 本班有剩、而別班缺這道菜 → 可以主動提供
        canShare: dishes.filter((d) => !d.shortage
          && (d.otherClasses || []).some((o) => o.shortage)).length,
      },
    });
  } catch (error) {
    console.error('取得菜品剩餘量失敗:', error);
    return bad(res, 500, error.message || '取得菜品剩餘量失敗');
  }
};

/**
 * GET /api/support/dish/:dishId?date=
 * 單一菜品的跨班分布。改為常態顯示後不再有「本班不缺就不給看」的限制。
 */
const getDishAcrossClasses = async (req, res) => {
  try {
    const classId = String(req.query.classId || req.user.classId || '');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.query.date) ? req.query.date : today();
    const { dishId } = req.params;

    const mineSnap = await db.collection(COL.dishLeftovers)
      .where('classId', '==', classId)
      .where('date', '==', date)
      .where('dishId', '==', dishId)
      .limit(1)
      .get();

    if (mineSnap.empty) return bad(res, 404, '本班今天沒有這道菜的紀錄');
    const mine = mineSnap.docs[0].data();
    const ratio = ratioOf(mine);

    const othersSnap = await db.collection(COL.dishLeftovers)
      .where('schoolId', '==', mine.schoolId || null)
      .where('date', '==', date)
      .where('dishId', '==', dishId)
      .orderBy('leftoverG', 'desc')
      .limit(10)
      .get();

    const otherClasses = othersSnap.docs
      .map((d) => d.data())
      .filter((o) => o.classId !== classId)
      .map(toOffer);

    return res.status(200).json({
      success: true,
      date,
      dishId,
      dishName: mine.dishName,
      remainingPct: Math.round(ratio * 100),
      shortage: ratio < SUPPORT.shortageRatio,
      otherClasses,
      offerCount: otherClasses.filter((o) => o.canOffer).length,
      generatedAt: Date.now(),
      message: otherClasses.some((o) => o.canOffer)
        ? `${otherClasses.filter((o) => o.canOffer).length} 個班級還有${mine.dishName}`
        : `目前沒有其他班級拿得出${mine.dishName}`,
    });
  } catch (error) {
    console.error('取得跨班菜品分布失敗:', error);
    return bad(res, 500, error.message || '取得跨班菜品分布失敗');
  }
};

module.exports = { getDishStatus, getDishAcrossClasses };
