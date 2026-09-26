/**
 * 無影像辨識服務時的退路估算。
 *
 * 真實辨識走 lib/vision.js（呼叫 vision_service）。這支只在
 * 「沒帶照片 / 未設定辨識服務 / 辨識失敗」時使用，讓流程不中斷 ——
 * 但輸出的殘餘比例會標記 needsReview，強制午餐長以滑桿確認，
 * 不讓估算值靜默進入統計。
 */

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(v, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(Number(v) * f) / f;
}

function pseudo(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** 湯品/蔬菜通常剩較多、主食較少，讓示範數據看起來合理。*/
function pseudoRatio(seed, slot) {
  const base = slot === 'soup' ? 0.35 : slot === 'veg' ? 0.3 : slot === 'staple' ? 0.1 : 0.2;
  return clamp01(base + pseudo(seed) * 0.25);
}

function hashSeed(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}

/**
 * @param {{bucketId:string, expected:Array<{slot:string,dishId:string|null,dishName:string}>,
 *          manualRatios?:Object, seed?:string}} params
 */
function recognizeBucket({ bucketId, expected, manualRatios, seed }) {
  const s = hashSeed(seed || bucketId);
  const manual = manualRatios || null;

  const items = expected.map((e, i) => {
    const hasManual = manual && manual[e.slot] !== undefined;
    const ratio = hasManual ? clamp01(manual[e.slot]) : pseudoRatio(s + i, e.slot);
    return {
      slot: e.slot,
      dishId: e.dishId,
      dishName: e.dishName,
      remainingRatio: round(ratio, 3),
      confidence: hasManual ? 1 : round(0.72 + pseudo(s + i * 3) * 0.24, 2),
      // 人工輸入視為已確認；估算值一律要求確認
      needsReview: !hasManual,
    };
  });

  const bucketConfidence = round(
    items.reduce((a, b) => a + b.confidence, 0) / Math.max(1, items.length),
    2
  );

  return {
    items,
    bucketConfidence,
    warnings: manual ? [] : ['此為預設估算值，非影像辨識結果，請確認各菜殘餘比例'],
    source: manual ? 'manual' : 'mock',
  };
}

module.exports = { recognizeBucket, clamp01, round };
