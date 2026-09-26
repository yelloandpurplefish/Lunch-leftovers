/**
 * 影像辨識服務（vision_service）的用戶端。
 *
 * 只負責「本系統資料模型 ↔ 辨識服務契約」的轉換：
 *   送出：桶別、當餐該桶的菜色（含分類與供應克數）、影像 base64
 *   取回：各菜色的殘餘比例(0~1)、克數、信心值、是否需人工確認
 *
 * 前期定位（使用者指定）：影像主要用於**資料收集與演算法優化分析**，
 * 因此每次呼叫的原始輸出（克數、信心、方法、警告）都會完整存進場次紀錄，
 * 即使最後採用的是午餐長人工確認的數值，也保留辨識當下的值以便日後比對。
 *
 * 未設定 VISION_API_BASE 或服務掛掉時，呼叫端會退回 lib/recognizer.js。
 */

const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 20000);
const VISION_TOKEN = process.env.VISION_TOKEN || '';

/** 雲端平台注入的值可能只有 host:port，沒有 scheme 就補 http://。*/
function normalizeBase(v) {
  const s = String(v || '').trim().replace(/\/$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
}

const VISION_API_BASE = normalizeBase(process.env.VISION_API_BASE);

function visionEnabled() {
  return VISION_API_BASE.length > 0;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(VISION_TOKEN ? { 'x-vision-token': VISION_TOKEN } : {}),
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(v, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(Number(v) * f) / f;
}

/** 服務狀態（前端據此顯示「拍照辨識」或「預設估算」）。*/
async function visionStatus() {
  if (!visionEnabled()) {
    return { enabled: false, ok: false, note: '後端未設定 VISION_API_BASE，將以預設估算代替辨識' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${VISION_API_BASE}/health`, { signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return {
      enabled: true,
      ok: res.ok,
      base: VISION_API_BASE,
      calibrated: Boolean(body.calibrated),
      canonicalPxPerMm: body.canonical_px_per_mm,
      algorithmModule: body.algorithm_module,
      note: body.calibrated ? undefined : '辨識服務未載入磅秤校正模型，克數僅供粗估',
    };
  } catch (error) {
    return { enabled: true, ok: false, base: VISION_API_BASE, note: `辨識服務無法連線（${error.message}）` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 辨識單一餐桶。
 * @param {{bucketId:string, image:string,
 *          expected:Array<{slot:string,dishId:string|null,dishName:string,category?:string,
 *                          suppliedG?:number,initialAreaFraction?:number}>,
 *          rectified?:boolean, pxPerMm?:number, tiltDeg?:number}} params
 * @throws 服務未設定／逾時／非 2xx／辨識失敗時丟出，由呼叫端退回估算
 */
async function recognizeBucketWithVision(params) {
  if (!visionEnabled()) throw new Error('未設定 VISION_API_BASE');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${VISION_API_BASE}/ml/recognize-bucket`, {
      method: 'POST',
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        bucket_type: params.bucketId,
        image: params.image,
        rectified: Boolean(params.rectified),
        px_per_mm: params.pxPerMm,
        tilt_deg: params.tiltDeg,
        expected_dishes: params.expected.map((e) => ({
          dish_id: e.dishId,
          name: e.dishName,
          category: e.category,
          slot: e.slot,
          supplied_g: e.suppliedG,
          initial_area_fraction: e.initialAreaFraction,
        })),
      }),
    });
  } catch (error) {
    throw new Error(
      error.name === 'AbortError'
        ? `辨識服務逾時（${TIMEOUT_MS}ms）`
        : `無法連線辨識服務：${error.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `辨識服務回應 HTTP ${res.status}`);
  if (body.ok === false) {
    throw new Error((body.warnings || []).join('；') || '辨識失敗（找不到餐盆）');
  }

  const bySlot = new Map((body.items || []).map((i) => [i.slot, i]));
  const items = params.expected.map((e) => {
    const hit = bySlot.get(e.slot);
    return {
      slot: e.slot,
      dishId: e.dishId,
      dishName: e.dishName,
      remainingRatio: clamp01(hit ? hit.remaining_ratio : 0),
      confidence: round(hit ? hit.confidence : 0, 2),
      needsReview: hit ? Boolean(hit.needs_review) : true,
      // 以下為演算法分析用的原始輸出，一併存檔（前期的主要目的）
      visionGrams: hit && hit.grams != null ? round(hit.grams, 1) : null,
      visionAreaFraction: hit && hit.area_fraction != null ? hit.area_fraction : null,
      method: hit ? hit.method : null,
    };
  });

  return {
    items,
    bucketConfidence: round(body.bucket_confidence || 0, 2),
    warnings: body.warnings || [],
    source: 'vision',
    serverMs: body.server_ms,
    tiltDeg: body.tilt_deg == null ? null : body.tilt_deg,
    pan: body.pan || null,
  };
}

module.exports = {
  VISION_API_BASE,
  visionEnabled,
  visionStatus,
  recognizeBucketWithVision,
};
