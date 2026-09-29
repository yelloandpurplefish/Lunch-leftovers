/**
 * ESP32 稱重模組會打的三個端點（韌體只需要實作這三個）。
 *
 *   POST /api/device/hello      開機：報到、對時、拿設定（扣重/校正/綁哪一班哪一桶）
 *   POST /api/device/heartbeat  定時心跳：回報電量/訊號/韌體版本，順便知道設定有沒有變
 *   POST /api/device/measure    上傳一筆秤重讀數
 *
 * 設計重點（給寫韌體的人）：
 *  · **裝置只上傳原始值**（raw / gross），換算與扣重都在伺服器。
 *    盆子換了、感測器漂移了，改伺服器設定即可，不必重燒韌體。
 *  · 每筆讀數要帶自己遞增的 `readingId`；伺服器用它做決定性 doc id，
 *    斷線重傳同一筆會覆蓋而不是變兩筆 —— 韌體可以無腦重試。
 *  · 回應一律帶 `serverTime` 與 `configVersion`，裝置據此對時與決定要不要重抓設定。
 *  · ESP32 沒有 RTC，開機時間不可信：伺服器以 `receivedAt` 為準，
 *    裝置回報的 `measuredAt` 只當參考。
 */
const { db, admin } = require('../config/firebase');
const { COL, DEVICE, ids, BUCKET_LAYOUT } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ ok: false, error: message, ...extra });

/** 裝置設定：韌體需要知道的全部內容。*/
function deviceConfig(device) {
  return {
    deviceId: device.id,
    configVersion: Number(device.configVersion || 1),
    classId: device.classId || null,
    className: device.className || null,
    bucketId: device.bucketId || null,
    bucketLabel: device.bucketId
      ? (BUCKET_LAYOUT.find((b) => b.id === device.bucketId) || {}).label || null
      : null,
    // 量測參數
    tareG: Number(device.tareG || 0),                       // 盆體扣重
    calibrationFactor: Number(device.calibrationFactor || 1), // raw/g
    zeroOffset: Number(device.zeroOffset || 0),
    // 行為參數（讓技術員可以遠端調，不必重燒）
    sampleIntervalSec: Number(device.sampleIntervalSec || 5),
    heartbeatIntervalSec: Number(device.heartbeatIntervalSec || 300),
    uploadOnChangeGrams: Number(device.uploadOnChangeGrams || 50),
    status: device.status || 'active',
  };
}

/** 原始值 → 淨剩食克數。裝置若已自算 grossG 就直接用，否則用 raw 換算。*/
function toNetGrams(device, { raw, grossG }) {
  const cfg = deviceConfig(device);
  const gross = Number.isFinite(Number(grossG))
    ? Number(grossG)
    : (Number(raw) - cfg.zeroOffset) / (cfg.calibrationFactor || 1);
  const net = gross - cfg.tareG;
  return {
    grossG: Math.round(gross * 10) / 10,
    netG: Math.round(net * 10) / 10,
  };
}

/**
 * POST /api/device/hello
 * body: { firmware?, mac?, bootCount?, resetReason? }
 */
const hello = async (req, res) => {
  try {
    const device = req.device;
    await req.deviceRef.set({
      lastSeenAt: serverTime(),
      lastBootAt: serverTime(),
      bootCount: admin.firestore.FieldValue.increment(1),
      firmware: req.body.firmware || device.firmware || null,
      mac: req.body.mac || device.mac || null,
      lastResetReason: req.body.resetReason || null,
      online: true,
    }, { merge: true });

    return res.status(200).json({
      ok: true,
      serverTime: new Date().toISOString(),
      serverDate: today(),
      config: deviceConfig(device),
      // 尚未綁定班級/桶別時明講，韌體可以亮燈提示現場人員
      needsProvisioning: !device.classId || !device.bucketId,
      message: !device.classId || !device.bucketId
        ? '此裝置尚未綁定班級與桶別，請技術員於後台設定'
        : undefined,
    });
  } catch (error) {
    console.error('裝置報到失敗:', error);
    return fail(res, 500, '報到失敗');
  }
};

/**
 * POST /api/device/heartbeat
 * body: { batteryPct?, rssi?, uptimeSec?, freeHeap?, queued? }
 */
const heartbeat = async (req, res) => {
  try {
    const device = req.device;
    await req.deviceRef.set({
      lastSeenAt: serverTime(),
      online: true,
      batteryPct: req.body.batteryPct != null ? Number(req.body.batteryPct) : (device.batteryPct ?? null),
      rssi: req.body.rssi != null ? Number(req.body.rssi) : (device.rssi ?? null),
      uptimeSec: req.body.uptimeSec != null ? Number(req.body.uptimeSec) : null,
      freeHeap: req.body.freeHeap != null ? Number(req.body.freeHeap) : null,
      queuedReadings: req.body.queued != null ? Number(req.body.queued) : 0,
    }, { merge: true });

    return res.status(200).json({
      ok: true,
      serverTime: new Date().toISOString(),
      // 設定版本有變就叫裝置重抓；沒變就只回這個數字，省流量
      configVersion: Number(device.configVersion || 1),
      configChanged: Number(req.body.configVersion || 0) !== Number(device.configVersion || 1),
    });
  } catch (error) {
    console.error('心跳失敗:', error);
    return fail(res, 500, '心跳失敗');
  }
};

/**
 * POST /api/device/measure
 * body: { readingId, raw? | grossG?, measuredAt?, date?, stable?, samples?, tempC? }
 *
 * 回應會附上伺服器換算後的淨重，方便現場用序列埠核對。
 */
const measure = async (req, res) => {
  try {
    const device = req.device;
    const readingId = String(req.body.readingId || '').trim();
    if (!readingId) return fail(res, 400, '缺少 readingId（裝置端遞增序號，用於去重）');
    if (req.body.raw == null && req.body.grossG == null) {
      return fail(res, 400, '需提供 raw 或 grossG');
    }

    // 日期以伺服器為準；允許裝置補傳最近幾天的離線資料
    const date = isYmd(req.body.date) ? req.body.date : today();
    if (date > today()) return fail(res, 400, '不接受未來日期的讀數');
    if (date < daysAgo(DEVICE.backfillDays)) {
      return fail(res, 400, `只接受最近 ${DEVICE.backfillDays} 天內的補傳資料`);
    }

    const { grossG, netG } = toNetGrams(device, req.body);

    // 超出合理範圍就標記異常：照收（現場排查需要原始資料），但不讓它污染統計
    const outOfRange = netG < DEVICE.minNetGrams || netG > DEVICE.maxNetGrams;
    const netClamped = Math.abs(netG) <= DEVICE.zeroBandGrams ? 0 : netG;

    const docId = ids.deviceReading(device.id, readingId);
    await db.collection(COL.deviceReadings).doc(docId).set({
      deviceId: device.id,
      readingId,
      classId: device.classId || null,
      bucketId: device.bucketId || null,
      date,
      raw: req.body.raw != null ? Number(req.body.raw) : null,
      grossG,
      tareG: Number(device.tareG || 0),
      netG: netClamped,
      stable: req.body.stable !== false,
      samples: req.body.samples != null ? Number(req.body.samples) : null,
      tempC: req.body.tempC != null ? Number(req.body.tempC) : null,
      measuredAt: req.body.measuredAt || null,   // 裝置回報時間，僅供參考
      receivedAt: serverTime(),                  // 以伺服器時間為準
      outOfRange,
      needsReview: outOfRange || req.body.stable === false,
      applied: false,                            // 是否已套用到當日場次（見下方說明）
    }, { merge: true });

    await req.deviceRef.set({ lastSeenAt: serverTime(), lastReadingAt: serverTime(), online: true }, { merge: true });

    return res.status(200).json({
      ok: true,
      serverTime: new Date().toISOString(),
      readingId,
      grossG,
      tareG: Number(device.tareG || 0),
      netG: netClamped,
      outOfRange,
      configVersion: Number(device.configVersion || 1),
      // 尚未綁定就照收但不會進統計，現場才知道要去設定
      stored: true,
      linked: Boolean(device.classId && device.bucketId),
    });
  } catch (error) {
    console.error('讀數上傳失敗:', error);
    return fail(res, 500, '讀數上傳失敗');
  }
};

module.exports = { hello, heartbeat, measure, deviceConfig, toNetGrams };
