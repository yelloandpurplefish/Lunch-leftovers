/**
 * 稱重量到的剩食克數 → 比例／成本／碳排，以及全班彙總。
 *
 *   當餐供應量 = 每份份量(portionG) × 供餐份數(班級人數)
 *   成本損耗   = 剩食克數 / 1000 × 單價(元/kg)
 *   碳排放     = 剩食克數 / 1000 × 排放係數(kgCO2e/kg)
 *
 * 這是單純的紀錄，不發幣（見 controllers/recordController.js）。
 */

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(v, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}

/**
 * 由**實測克數**算出各欄位。
 *
 * leftoverG 原樣保留，成本與碳排也直接由實測公斤數算，
 * 只有 remainingRatio（給介面顯示用）才夾在 0–1——量測值不能被估算值蓋掉。
 *
 * 實測大於供應量時回一個 warning：那通常代表供應份數填錯或皮重設定錯，
 * 應該讓人去查，而不是默默截掉。
 */
function leftoverFromWeight(dish, measuredG, servings) {
  const leftoverG = Math.max(0, Number(measuredG) || 0);
  const suppliedG = Number(dish.portionG || 0) * Number(servings || 0);
  const kg = leftoverG / 1000;
  const rawRatio = suppliedG > 0 ? leftoverG / suppliedG : 0;

  const warnings = [];
  if (suppliedG > 0 && leftoverG > suppliedG * 1.05) {
    warnings.push(
      `量到的剩餘量 ${round(leftoverG, 1)} g 比供應量 ${round(suppliedG, 1)} g 還多，`
      + '請確認供應份數與桶型皮重是否正確'
    );
  }

  return {
    suppliedG: round(suppliedG, 1),
    leftoverG: round(leftoverG, 1),
    remainingRatio: clamp01(rawRatio),
    rawRatio: round(rawRatio, 4),
    cost: round(kg * Number(dish.unitCost || 0), 2),
    co2e: round(kg * Number(dish.emissionFactor || 0), 3),
    warnings,
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

module.exports = {
  clamp01,
  round,
  leftoverFromWeight,
  summarize,
};
