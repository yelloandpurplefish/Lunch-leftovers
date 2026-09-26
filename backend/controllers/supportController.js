/**
 * 跨班支援：細到「每班每個菜品」的剩餘量。
 *
 * 規則（使用者指定）：
 *   **只有在本班此菜品剩餘量低於門檻時**，才顯示其他班是否還有這道菜。
 *   剩餘充足的菜品不會洩漏別班資料 —— 沒有需求就不顯示。
 *
 * 門檻在 config/schema.js 的 SUPPORT：
 *   shortageRatio  本班剩餘克數 ÷ 當餐供應克數 < 0.15 視為不足
 *   minOfferGrams  其他班至少要剩 300g 才算「還有」，避免顯示幾乎見底的班級
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
 * GET /api/support/dishes?date=
 * 本班今天各菜品剩餘量；不足的菜品附上「其他班還有嗎」。
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
        message: '今天還沒有紀錄，午餐長完成辨識後才會顯示各菜品剩餘量',
      });
    }

    const mine = mineSnap.docs.map((d) => d.data());
    const schoolId = mine[0].schoolId || null;

    const dishes = [];
    for (const row of mine) {
      const ratio = ratioOf(row);
      const shortage = ratio < SUPPORT.shortageRatio;

      const entry = {
        slot: row.slot,
        dishId: row.dishId,
        dishName: row.dishName,
        category: row.category,
        suppliedG: Math.round(Number(row.suppliedG || 0)),
        leftoverG: Math.round(Number(row.leftoverG || 0)),
        remainingPct: Math.round(ratio * 100),
        shortage,
        // 充足的菜品不查別班，也不回傳別班資料
        otherClasses: null,
      };

      if (shortage && row.dishId) {
        const othersSnap = await db.collection(COL.dishLeftovers)
          .where('schoolId', '==', schoolId)
          .where('date', '==', date)
          .where('dishId', '==', row.dishId)
          .orderBy('leftoverG', 'desc')
          .limit(10)
          .get();

        entry.otherClasses = othersSnap.docs
          .map((d) => d.data())
          .filter((o) => o.classId !== classId && Number(o.leftoverG || 0) >= SUPPORT.minOfferGrams)
          .map((o) => ({
            classId: o.classId,
            className: o.className,
            grade: o.grade,
            leftoverG: Math.round(Number(o.leftoverG || 0)),
            remainingPct: Math.round(ratioOf(o) * 100),
          }));
      }
      dishes.push(entry);
    }

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
      summary: {
        total: dishes.length,
        shortages: shortages.length,
        withHelp: shortages.filter((d) => (d.otherClasses || []).length > 0).length,
      },
    });
  } catch (error) {
    console.error('取得菜品剩餘量失敗:', error);
    return bad(res, 500, error.message || '取得菜品剩餘量失敗');
  }
};

/**
 * GET /api/support/dish/:dishId?date=
 * 單一菜品的跨班分布（僅在本班該菜品不足時才允許查看，避免繞過門檻）。
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

    if (ratio >= SUPPORT.shortageRatio) {
      return res.status(200).json({
        success: true,
        date,
        dishId,
        dishName: mine.dishName,
        remainingPct: Math.round(ratio * 100),
        shortage: false,
        otherClasses: null,
        message: `本班的${mine.dishName}還有 ${Math.round(ratio * 100)}%，不需要跨班支援`,
      });
    }

    const othersSnap = await db.collection(COL.dishLeftovers)
      .where('schoolId', '==', mine.schoolId || null)
      .where('date', '==', date)
      .where('dishId', '==', dishId)
      .orderBy('leftoverG', 'desc')
      .limit(10)
      .get();

    const otherClasses = othersSnap.docs
      .map((d) => d.data())
      .filter((o) => o.classId !== classId && Number(o.leftoverG || 0) >= SUPPORT.minOfferGrams)
      .map((o) => ({
        classId: o.classId,
        className: o.className,
        grade: o.grade,
        leftoverG: Math.round(Number(o.leftoverG || 0)),
        remainingPct: Math.round(ratioOf(o) * 100),
      }));

    return res.status(200).json({
      success: true,
      date,
      dishId,
      dishName: mine.dishName,
      remainingPct: Math.round(ratio * 100),
      shortage: true,
      otherClasses,
      message: otherClasses.length
        ? `${otherClasses.length} 個班級還有${mine.dishName}`
        : `目前沒有其他班級還有${mine.dishName}`,
    });
  } catch (error) {
    console.error('取得跨班菜品分布失敗:', error);
    return bad(res, 500, error.message || '取得跨班菜品分布失敗');
  }
};

module.exports = { getDishStatus, getDishAcrossClasses };
