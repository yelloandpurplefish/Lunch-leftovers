/**
 * 桶型皮重（空桶重）。
 *
 * ## 為什麼按「桶型」而不是按桶、也不是按班級
 *
 * 一個班級只有一台秤，量測時是一桶一桶輪流放上去。同一款桶的空重一樣，
 * 所以皮重只需要**按桶型**登錄一次，而且**全校共用**：
 *
 *   主食桶   → 主食
 *   菜桶     → 主菜、副菜一、副菜二、蔬菜（四個同款桶）
 *   湯桶     → 湯品
 *
 * 這樣現場不必先歸零、不必選桶：系統從「這一筆是哪道菜」就推得出桶型，
 * 午餐長只要一桶一桶拿上來測。
 *
 * ## 兩層扣重怎麼疊
 *
 *   裝置的 tareG      秤台上**固定**的東西（托盤、支架）—— 由技術員校正時設定
 *   桶型皮重（本檔）  放上去的容器 —— 由管理員在面板量測
 *
 *   剩餘量 = netG − 桶型皮重
 *          （netG 已經是 grossG − 裝置 tareG，見 deviceController.toNetGrams）
 *
 * 兩層分開的理由：托盤不會換，桶子會換。混在一起的話換桶就得重新校正裝置。
 */
const { db, admin } = require('../config/firebase');
const { COL, BUCKET_TYPES, SLOT_BUCKET_TYPE, BUCKET_TARE_DOC_ID } = require('../config/schema');

const CACHE_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

/** 皮重的合理範圍（公克）。超出多半是拿錯東西上秤或單位錯。 */
const TARE_RANGE = [0, 20000];

function invalidateTares() {
  cache = null;
  cachedAt = 0;
}

function tareDocRef() {
  return db.collection(COL.systemConfig).doc(BUCKET_TARE_DOC_ID);
}

/**
 * 取全部桶型的皮重。
 * 尚未設定的桶型回 null（不是 0）——0 是「量過，而且真的是 0」，
 * null 是「還沒量」。這兩件事對介面與驗證的意義完全不同。
 */
async function getTares({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  let stored = {};
  try {
    const snap = await tareDocRef().get();
    if (snap.exists) stored = snap.data() || {};
  } catch (error) {
    console.error('讀取桶型皮重失敗:', error.message);
  }

  const values = {};
  const meta = {};
  for (const t of BUCKET_TYPES) {
    const row = stored[t.id];
    if (row && Number.isFinite(Number(row.tareG))) {
      values[t.id] = Number(row.tareG);
      meta[t.id] = {
        measuredWith: row.measuredWith || null,
        measuredAt: row.measuredAt && row.measuredAt.toDate
          ? row.measuredAt.toDate().toISOString() : null,
        updatedBy: row.updatedByName || null,
        method: row.method || null,
      };
    } else {
      values[t.id] = null;
      meta[t.id] = null;
    }
  }

  const out = { values, meta };
  cache = out;
  cachedAt = Date.now();
  return out;
}

/** 菜色欄位（slot）→ 桶型 id。 */
function bucketTypeForSlot(slot) {
  return SLOT_BUCKET_TYPE[slot] || null;
}

/** 桶型的顯示名稱。 */
function bucketTypeLabel(typeId) {
  const t = BUCKET_TYPES.find((x) => x.id === typeId);
  return t ? t.label : typeId;
}

/**
 * 某道菜該扣多少皮重。
 * @returns {{ok:true, tareG:number, bucketType:string, label:string}
 *          |{ok:false, reason:string, bucketType:string|null}}
 */
function tareForSlot(slot, tares) {
  const type = bucketTypeForSlot(slot);
  if (!type) return { ok: false, reason: `未知的菜色欄位：${slot}`, bucketType: null };
  const v = tares.values[type];
  if (v === null || v === undefined) {
    return {
      ok: false,
      bucketType: type,
      reason: `「${bucketTypeLabel(type)}」還沒設定皮重，請管理員先到面板量測`,
    };
  }
  return { ok: true, tareG: v, bucketType: type, label: bucketTypeLabel(type) };
}

/** 寫入一個桶型的皮重。method 記錄是量測來的還是手動輸入的。 */
async function setTare({ bucketType, tareG, method, deviceId, uid, displayName }) {
  const type = BUCKET_TYPES.find((t) => t.id === bucketType);
  if (!type) {
    const err = new Error(`未知的桶型：${bucketType}`);
    err.status = 400;
    throw err;
  }
  const v = Number(tareG);
  if (!Number.isFinite(v)) {
    const err = new Error('皮重必須是數字');
    err.status = 400;
    throw err;
  }
  const [lo, hi] = TARE_RANGE;
  if (v < lo || v > hi) {
    const err = new Error(`皮重 ${v} g 超出合理範圍 ${lo}–${hi} g，請確認是不是拿錯東西上秤`);
    err.status = 400;
    throw err;
  }

  await tareDocRef().set({
    [bucketType]: {
      tareG: Math.round(v * 10) / 10,
      method: method || 'manual',
      measuredWith: deviceId || null,
      measuredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid || null,
      updatedByName: displayName || null,
    },
  }, { merge: true });

  invalidateTares();
  return getTares({ force: true });
}

module.exports = {
  BUCKET_TYPES,
  TARE_RANGE,
  getTares,
  setTare,
  tareForSlot,
  bucketTypeForSlot,
  bucketTypeLabel,
  invalidateTares,
};
