/**
 * 剩量 → 克數 → 成本/碳排 → 營養攝取與減碳 → E幣 / S幣。
 *
 *   剩食克數(菜) = 殘餘比例 × 當餐供應量
 *   當餐供應量   = 每份份量(portionG) × 供餐份數(班級人數)
 *   成本損耗     = 剩食克數 / 1000 × 單價(元/kg)
 *   碳排放       = 剩食克數 / 1000 × 排放係數(kgCO2e/kg)
 *
 * ## 兩種幣的語意
 *
 *   E = Energy —— 學生實際**吃下去**的營養
 *       攝取量 = 供應 − 剩餘
 *       E = 人均蛋白質(g) × kProtein + 人均膳食纖維(g) × kFiber
 *
 *   S = SDGs —— 比全校歷史平均**少浪費**的部分，換算成碳排，再換算成樹
 *       少浪費 = max(0, 全校歷史人均廚餘 − 本班人均廚餘)
 *       碳排   = 少浪費(kg) × co2PerKgWaste
 *       樹     = 碳排 ÷ 每棵樹每年吸收的 CO2
 *       S 幣   = round(樹 × sCoinPerTree)
 *
 * 兩者都以**人均**計算，再全額加給班上每位學生（班級人數不同，不人均不公平）。
 * 所有係數都可在開發者面板調整，見 lib/settings.js。
 *
 * 殘餘比例由影像辨識服務提供（定義為「殘餘 ÷ 供應」），
 * 信心不足時由午餐長以滑桿確認，見 controllers/recordController.js。
 */
const { COIN_RULES } = require('../config/schema');

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(v, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}

/** 單道菜：殘餘比例 → 克數/成本/碳排。*/
function computeLeftover(dish, remainingRatio, servings) {
  const ratio = clamp01(remainingRatio);
  const suppliedG = Number(dish.portionG || 0) * Number(servings || 0);
  const leftoverG = ratio * suppliedG;
  const kg = leftoverG / 1000;
  return {
    suppliedG: round(suppliedG, 1),
    leftoverG: round(leftoverG, 1),
    cost: round(kg * Number(dish.unitCost || 0), 2),
    co2e: round(kg * Number(dish.emissionFactor || 0), 3),
  };
}

/** 當餐彙總 = 各菜加總。*/
function summarize(leftovers) {
  return leftovers.reduce(
    (acc, l) => ({
      totalG: round(acc.totalG + Number(l.leftoverG || 0), 1),
      totalCost: round(acc.totalCost + Number(l.cost || 0), 2),
      totalCo2e: round(acc.totalCo2e + Number(l.co2e || 0), 3),
    }),
    { totalG: 0, totalCost: 0, totalCo2e: 0 }
  );
}

/**
 * 減碳量：以該班該菜「近 N 餐移動平均剩食」為基準，鼓勵比自己過去更好。
 * @param {Map<string, object>} dishById
 * @param {Map<string, number>} baselineByDish dishId → 平均剩食克數（沒有就用供應量×預設比例）
 */
function computeReduction(leftovers, dishById, baselineByDish, servings) {
  let baselineCo2e = 0;
  let actualCo2e = 0;
  let reducedCo2e = 0;

  for (const l of leftovers) {
    if (!l.dishId) continue;
    const dish = dishById.get(l.dishId);
    if (!dish) continue;
    const ef = Number(dish.emissionFactor || 0);
    const suppliedG = Number(dish.portionG || 0) * Number(servings || 0);
    const baseG = baselineByDish.has(l.dishId)
      ? baselineByDish.get(l.dishId)
      : suppliedG * COIN_RULES.fallbackBaselineRatio;

    baselineCo2e += (baseG / 1000) * ef;
    actualCo2e += (Number(l.leftoverG || 0) / 1000) * ef;
    reducedCo2e += (Math.max(0, baseG - Number(l.leftoverG || 0)) / 1000) * ef;
  }

  return {
    baselineCo2e: round(baselineCo2e, 3),
    actualCo2e: round(actualCo2e, 3),
    reducedCo2e: round(reducedCo2e, 3),
  };
}

/** 班級當餐 E幣 = round(減碳量 × k_E)，不為負。*/
function computeClassECoins(reducedCo2e) {
  return Math.max(0, Math.round(Number(reducedCo2e || 0) * COIN_RULES.k_E));
}


// ── E 幣：攝取營養 ────────────────────────────────────────────────

/**
 * 這道菜每公斤含多少蛋白質與膳食纖維。
 * 優先用菜品自己的設定，沒有才用分類預設——
 * 分類預設是給「還沒細填營養的菜」用的保底，不是覆蓋個別菜品的權威值。
 */
function nutrientsOf(dish, category, settings) {
  const cat = (dish && dish.category) || category || '';
  const byCat = (settings.nutrition && settings.nutrition.byCategory) || {};
  const base = byCat[cat] || (settings.nutrition && settings.nutrition.fallback) || {};
  const pick = (field) => {
    const own = dish && dish[field];
    const v = Number(own != null && own !== '' ? own : base[field]);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return { proteinPerKg: pick('proteinPerKg'), fiberPerKg: pick('fiberPerKg') };
}

/**
 * 全班實際攝取的營養（供應 − 剩餘），同時回傳人均。
 * @param {Array} leftovers 各菜的 { dishId, category, suppliedG, leftoverG }
 * @param {Map} dishById 菜品資料（可能含 proteinPerKg / fiberPerKg 覆寫）
 */
function computeNutrition(leftovers, dishById, servings, settings) {
  let proteinG = 0;
  let fiberG = 0;
  let eatenG = 0;
  const byDish = [];

  for (const l of leftovers) {
    const dish = l.dishId && dishById ? dishById.get(l.dishId) : null;
    const suppliedG = Number(l.suppliedG || 0)
      || (dish ? Number(dish.portionG || 0) * Number(servings || 0) : 0);
    // 剩餘可能因人工微調而略大於供應，夾住避免出現負的攝取量
    const eaten = Math.max(0, suppliedG - Number(l.leftoverG || 0));
    const { proteinPerKg, fiberPerKg } = nutrientsOf(dish, l.category, settings);
    const p = (eaten / 1000) * proteinPerKg;
    const f = (eaten / 1000) * fiberPerKg;
    proteinG += p;
    fiberG += f;
    eatenG += eaten;
    byDish.push({
      dishId: l.dishId || null,
      dishName: l.dishName || (dish && dish.name) || null,
      eatenG: round(eaten, 1),
      proteinG: round(p, 2),
      fiberG: round(f, 2),
    });
  }

  const n = Math.max(1, Number(servings || 0));
  return {
    eatenG: round(eatenG, 1),
    proteinG: round(proteinG, 2),
    fiberG: round(fiberG, 2),
    perCapita: {
      eatenG: round(eatenG / n, 1),
      proteinG: round(proteinG / n, 2),
      fiberG: round(fiberG / n, 2),
    },
    byDish,
  };
}

/** E 幣 = 人均蛋白質 × kProtein + 人均膳食纖維 × kFiber。 */
function computeEnergyCoins(nutrition, settings) {
  const e = (settings && settings.energy) || {};
  const kP = Number(e.kProtein || 0);
  const kF = Number(e.kFiber || 0);
  const raw = nutrition.perCapita.proteinG * kP + nutrition.perCapita.fiberG * kF;
  return {
    raw: round(raw, 3),
    fromProtein: round(nutrition.perCapita.proteinG * kP, 3),
    fromFiber: round(nutrition.perCapita.fiberG * kF, 3),
    coins: Math.max(0, Math.round(raw)),
  };
}

// ── S 幣：少浪費 → 碳排 → 樹 ─────────────────────────────────────

/**
 * 比全校歷史人均廚餘少浪費多少，換算成碳排與樹。
 *
 * 比全校歷史平均**差**的時候回 0 而不是負數：發負幣沒有意義，
 * 而且會讓一次失常抹掉整個學期的累積。
 *
 * @param {number} classWastePerCapitaG 本班本餐人均廚餘（g）
 * @param {number} schoolAvgPerCapitaG  全校歷史人均廚餘（g）
 */
function computeSdg({ classWastePerCapitaG, schoolAvgPerCapitaG, servings, settings }) {
  const s = (settings && settings.sdg) || {};
  const co2PerKg = Number(s.co2PerKgWaste || 0);
  const treeKg = Number(s.treeAnnualCo2Kg || 0);
  const perTree = Number(s.sCoinPerTree || 0);

  const savedPerCapitaG = Math.max(
    0,
    Number(schoolAvgPerCapitaG || 0) - Number(classWastePerCapitaG || 0)
  );
  const co2PerCapitaKg = (savedPerCapitaG / 1000) * co2PerKg;
  // treeAnnualCo2Kg 由面板調整，設成 0 會讓這裡變成 Infinity
  const treesPerCapita = treeKg > 0 ? co2PerCapitaKg / treeKg : 0;
  const n = Math.max(0, Number(servings || 0));

  return {
    savedPerCapitaG: round(savedPerCapitaG, 1),
    co2PerCapitaKg: round(co2PerCapitaKg, 4),
    co2ClassKg: round(co2PerCapitaKg * n, 3),
    treesPerCapita: round(treesPerCapita, 5),
    treesClass: round(treesPerCapita * n, 4),
    coins: Math.max(0, Math.round(treesPerCapita * perTree)),
  };
}

module.exports = {
  clamp01,
  round,
  computeLeftover,
  summarize,
  computeReduction,
  computeClassECoins,
  nutrientsOf,
  computeNutrition,
  computeEnergyCoins,
  computeSdg,
};
