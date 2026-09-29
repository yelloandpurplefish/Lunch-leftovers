/**
 * 剩量 → 克數 → 成本/碳排 → 減碳量 → 班級 E幣。
 *
 *   剩食克數(菜) = 殘餘比例 × 當餐供應量
 *   當餐供應量   = 每份份量(portionG) × 供餐份數(班級人數)
 *   成本損耗     = 剩食克數 / 1000 × 單價(元/kg)
 *   碳排放       = 剩食克數 / 1000 × 排放係數(kgCO2e/kg)
 *   減碳量       = Σ max(0, 基準剩食 − 實際剩食)/1000 × 排放係數
 *   班級 E幣     = round(減碳量 × k_E)
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

module.exports = {
  clamp01,
  round,
  computeLeftover,
  summarize,
  computeReduction,
  computeClassECoins,
};
