/**
 * 取回 ESP32 推送的最新重量讀數，並轉成影像模組看得懂的狀態。
 *
 * ## 資料怎麼來的
 *
 * 裝置以 `POST /api/device/measure` 推送 → 寫入 `device_readings`。
 * 本檔是**反向**：紀錄流程要量某一班某一桶時，來這裡取「那個桶最新的一筆」。
 * 這就是與影像模組 `scale.py` 之 CloudScale 相同的橋接方向，差別只在
 * 後端直接讀 Firestore，不必多繞一次 HTTP。
 *
 * ## 狀態判定比模組的區網模式更精確
 *
 * 區網直連時模組只拿得到一個數字，無法分辨「盆是空的」與「盆不在秤上」，
 * 只好一律以 `scale_min_valid_g` 當門檻 → 兩者都報 NO_LOAD 請人確認。
 *
 * 但橋接模式拿得到 **grossG（盆＋食物）與 tareG（盆重）兩個值**，因此可以分辨：
 *   · grossG 遠低於 tareG → 盆根本不在秤上 → no_load
 *   · grossG ≈ tareG      → 盆在秤上且是空的 → **ok，淨重 0**
 *
 * 這個差異很重要：「這一盆吃光了」是最有價值的紀錄之一，
 * 若每次都跳出確認視窗，就會養成盲目點擊的習慣，確認機制隨即失效
 * （模組 session.py 開頭所說的「確認疲勞」）。
 *
 * 裝置若尚未設定盆體扣重（tareG = 0），無從分辨，退回模組的保守門檻並附註說明。
 */
const { db } = require('../config/firebase');
const { COL, DEVICE } = require('../config/schema');

/** 未設定扣重時，淨重低於此值視為「未放置」（對應模組的 scale_min_valid_g）。 */
const MIN_VALID_G = 200;

/** 讀數超過這個秒數就不能再當作「現在的重量」。 */
const DEFAULT_MAX_AGE_SEC = 20;

/** 盆若在秤上，毛重至少應有盆重的一半；低於此判定為盆不在秤上。 */
const PAN_PRESENT_RATIO = 0.5;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Firestore Timestamp / Date / 毫秒數都可能出現，一律轉成毫秒。 */
function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把一筆 device_readings 轉成影像模組的 ScaleReading 形狀。
 * 回傳值直接可放進辨識請求的 `scale` 欄位。
 */
function classify(doc, { maxAgeSec = DEFAULT_MAX_AGE_SEC, now = Date.now() } = {}) {
  if (!doc) {
    return { state: 'offline', note: '此班此桶尚無任何讀數（裝置未綁定或未上傳）' };
  }

  const receivedMs = toMillis(doc.receivedAt);
  const ageSec = receivedMs ? Math.max(0, (now - receivedMs) / 1000) : Infinity;
  if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) {
    // 後端永遠回得出「最後一筆」，沉默地採用幾小時前的讀數比直接報離線更危險。
    return {
      state: 'offline',
      ageSec: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
      note: Number.isFinite(ageSec)
        ? `最新讀數已是 ${Math.round(ageSec)} 秒前，超過 ${maxAgeSec} 秒，視為離線`
        : '讀數缺少時間戳，無法判斷新舊',
    };
  }

  const grossG = num(doc.grossG);
  const tareG = num(doc.tareG);
  const netG = num(doc.netG);
  const stable = Boolean(doc.stable);

  const base = {
    value_g: Math.round(netG * 10) / 10,
    stable,
    n_samples: num(doc.samples, 0),
    ts: receivedMs / 1000,
    ageSec: Math.round(ageSec),
    grossG,
    tareG,
    deviceId: doc.deviceId || null,
    readingId: doc.readingId || null,
  };

  if (doc.outOfRange || netG > num(DEVICE.maxNetGrams, 60000)) {
    return { ...base, state: 'overload', note: '讀數超出量程' };
  }

  if (tareG > 0) {
    if (grossG < tareG * PAN_PRESENT_RATIO) {
      return { ...base, state: 'no_load', note: '毛重遠低於盆重，餐盆可能不在秤上' };
    }
  } else if (netG < MIN_VALID_G) {
    // 沒有扣重就無從分辨「空盆」與「沒放盆」，只能請人確認，並點出設定缺口。
    return {
      ...base,
      state: 'no_load',
      note: `裝置尚未設定盆體扣重，無法分辨空盆與未放置（請技術員執行空盆歸零）`,
    };
  }

  if (!stable) {
    return { ...base, state: 'unstable', note: '讀數尚未穩定' };
  }
  return { ...base, state: 'ok', note: '' };
}

/**
 * 取某班某桶最新的一筆讀數。
 *
 * 刻意分兩步查（先找裝置、再找該裝置的最新讀數），為的是**沿用既有的兩個索引**：
 *   devices(classId, bucketId)  與  device_readings(deviceId, receivedAt DESC)
 * 直接用 device_readings(classId, bucketId, receivedAt) 一次查完雖然少一次往返，
 * 卻要多開一個複合索引；而且分兩步才能分辨「沒綁裝置」與「綁了但沒上傳」，
 * 對現場排查更有用。
 *
 * 查不到或出錯一律回 offline —— 秤壞掉不該讓整個紀錄流程失敗，
 * 而是降級為純影像模式並明確標記（要不要中斷由影像模組的分級決定）。
 */
async function latestReading({ classId, bucketId, maxAgeSec = DEFAULT_MAX_AGE_SEC } = {}) {
  if (!classId || !bucketId) {
    return { state: 'disabled', note: '未指定班級或桶別' };
  }
  try {
    const devSnap = await db
      .collection(COL.devices)
      .where('classId', '==', classId)
      .where('bucketId', '==', bucketId)
      .limit(1)
      .get();
    if (devSnap.empty) {
      return { state: 'disabled', note: '此班此桶尚未綁定稱重模組，將以純影像模式紀錄' };
    }
    const device = devSnap.docs[0].data();
    if (device.status === 'disabled') {
      return { state: 'offline', note: `裝置 ${device.deviceId || ''} 已被停用，請洽技術員` };
    }

    const snap = await db
      .collection(COL.deviceReadings)
      .where('deviceId', '==', device.deviceId || devSnap.docs[0].id)
      .orderBy('receivedAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) {
      return { state: 'offline', note: '裝置已綁定但尚未上傳任何讀數' };
    }
    return classify(snap.docs[0].data(), { maxAgeSec });
  } catch (error) {
    return { state: 'offline', note: `讀取感測器資料失敗：${error.message}` };
  }
}

module.exports = {
  latestReading,
  classify,
  MIN_VALID_G,
  DEFAULT_MAX_AGE_SEC,
  PAN_PRESENT_RATIO,
};
