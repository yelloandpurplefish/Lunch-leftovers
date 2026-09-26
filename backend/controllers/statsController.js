/**
 * 剩餘量變化曲線。
 *
 *  GET /api/stats/leftover-trend?scope=class|school&range=week|month&dishId=&classId=
 *
 *  · scope=class（預設）本班每日總剩食克數；給 dishId 就只看那道菜的變化。
 *  · scope=school 全校每日總剩食（各班加總），可看整體趨勢。
 *  · 日期會補齊（沒紀錄的日子填 null 而非 0）—— 0 代表「全部吃完」，
 *    沒量測代表「沒資料」，兩者在曲線上意義完全不同，不可混為一談。
 *
 *  另外提供 GET /api/stats/dish-ranking：週期內最常被剩下的菜色，
 *  供排菜參考（資料來自 dish_leftovers，細到每班每菜品）。
 */
const { db } = require('../config/firebase');
const { COL } = require('../config/schema');
const { daysAgo, rangeYmd, isYmd } = require('../lib/dates');

const bad = (res, status, message) => res.status(status).json({ success: false, message });
const round = (v, d = 1) => Math.round(Number(v) * Math.pow(10, d)) / Math.pow(10, d);

const getLeftoverTrend = async (req, res) => {
  try {
    const scope = req.query.scope === 'school' ? 'school' : 'class';
    const days = String(req.query.range || 'week').includes('month') ? 30 : 7;
    const since = daysAgo(days - 1);
    const dishId = req.query.dishId ? String(req.query.dishId) : null;
    const classId = String(req.query.classId || req.user.classId || '');

    if (scope === 'class' && !classId) return bad(res, 400, '此帳號尚未編入班級');

    let q = db.collection(COL.dishLeftovers).where('date', '>=', since);
    q = scope === 'school'
      ? q.where('schoolId', '==', req.user.schoolId || null)
      : q.where('classId', '==', classId);
    if (dishId) q = q.where('dishId', '==', dishId);

    const snap = await q.get();

    // 依日期彙總（沒有資料的日子留 null）
    const byDate = new Map();
    snap.docs.forEach((d) => {
      const x = d.data();
      const cur = byDate.get(x.date) || { leftoverG: 0, suppliedG: 0, co2e: 0, cost: 0, dishes: 0 };
      cur.leftoverG += Number(x.leftoverG || 0);
      cur.suppliedG += Number(x.suppliedG || 0);
      cur.co2e += Number(x.co2e || 0);
      cur.cost += Number(x.cost || 0);
      cur.dishes += 1;
      byDate.set(x.date, cur);
    });

    const points = rangeYmd(since, days).map((date) => {
      const v = byDate.get(date);
      if (!v) return { date, leftoverG: null, remainingPct: null, co2e: null, cost: null };
      return {
        date,
        leftoverG: round(v.leftoverG, 1),
        remainingPct: v.suppliedG > 0 ? Math.round((v.leftoverG / v.suppliedG) * 100) : null,
        co2e: round(v.co2e, 3),
        cost: round(v.cost, 2),
        dishes: v.dishes,
      };
    });

    const measured = points.filter((p) => p.leftoverG !== null);
    return res.status(200).json({
      success: true,
      scope,
      range: `${days}d`,
      since,
      dishId,
      classId: scope === 'class' ? classId : null,
      points,
      stats: {
        measuredDays: measured.length,
        totalLeftoverG: round(measured.reduce((a, p) => a + p.leftoverG, 0), 1),
        avgLeftoverG: measured.length ? round(measured.reduce((a, p) => a + p.leftoverG, 0) / measured.length, 1) : null,
        bestDay: measured.length ? measured.reduce((a, p) => (p.leftoverG < a.leftoverG ? p : a)).date : null,
        worstDay: measured.length ? measured.reduce((a, p) => (p.leftoverG > a.leftoverG ? p : a)).date : null,
      },
    });
  } catch (error) {
    console.error('取得剩餘量曲線失敗:', error);
    return bad(res, 500, error.message || '取得剩餘量曲線失敗');
  }
};

/** GET /api/stats/dish-ranking?scope=class|school&range= — 週期內最常被剩下的菜色 */
const getDishRanking = async (req, res) => {
  try {
    const scope = req.query.scope === 'school' ? 'school' : 'class';
    const days = String(req.query.range || 'month').includes('week') ? 7 : 30;
    const since = daysAgo(days - 1);
    const classId = String(req.query.classId || req.user.classId || '');
    if (scope === 'class' && !classId) return bad(res, 400, '此帳號尚未編入班級');

    let q = db.collection(COL.dishLeftovers).where('date', '>=', since);
    q = scope === 'school'
      ? q.where('schoolId', '==', req.user.schoolId || null)
      : q.where('classId', '==', classId);
    const snap = await q.get();

    const byDish = new Map();
    snap.docs.forEach((d) => {
      const x = d.data();
      if (!x.dishId) return;
      const cur = byDish.get(x.dishId) || { dishName: x.dishName, category: x.category, leftoverG: 0, suppliedG: 0, times: 0 };
      cur.leftoverG += Number(x.leftoverG || 0);
      cur.suppliedG += Number(x.suppliedG || 0);
      cur.times += 1;
      byDish.set(x.dishId, cur);
    });

    const rows = [...byDish.entries()]
      .map(([dishId, v]) => ({
        dishId,
        dishName: v.dishName,
        category: v.category,
        times: v.times,
        totalLeftoverG: round(v.leftoverG, 1),
        avgRemainingPct: v.suppliedG > 0 ? Math.round((v.leftoverG / v.suppliedG) * 100) : 0,
      }))
      .sort((a, b) => b.avgRemainingPct - a.avgRemainingPct);

    rows.forEach((r, i) => { r.rank = i + 1; });

    return res.status(200).json({
      success: true,
      scope,
      range: `${days}d`,
      since,
      rows,
      mostLeftover: rows[0] || null,
      leastLeftover: rows[rows.length - 1] || null,
    });
  } catch (error) {
    console.error('取得菜色剩食排名失敗:', error);
    return bad(res, 500, error.message || '取得菜色剩食排名失敗');
  }
};

module.exports = { getLeftoverTrend, getDishRanking };
