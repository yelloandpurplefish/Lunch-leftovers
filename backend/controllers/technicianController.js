/**
 * 技術員專區：稱重模組的佈建與維護。
 *
 * 技術員只碰硬體，碰不到學生資料、幣、勾選紀錄 —— 這是刻意的權限切分：
 * 來校維修的人不該因為要調一個扣重，就拿到全校學生的個資。
 *
 * 主要流程：
 *   1. 批次註冊裝置（先貼標籤、再入庫）→ 取得一次性 token 交給韌體
 *   2. 現場綁定：這台模組是哪一班的哪一個桶
 *   3. 空盆歸零：把目前讀數設成盆體扣重（tare），或直接輸入已知盆重
 *   4. 校正：放已知砝碼，算出 raw→g 的係數
 *   5. 看機隊狀態：誰離線、誰電量低、誰讀數異常
 *
 * 任何會影響量測的設定變更都會讓 configVersion +1，
 * 裝置下次心跳就知道要重抓設定（不必等重開機）。
 */
const { db, admin } = require('../config/firebase');
const { COL, DEVICE, BUCKET_LAYOUT } = require('../config/schema');
const { hashToken, generateToken } = require('../middleware/deviceAuth');
const { today, daysAgo } = require('../lib/dates');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const norm = (v) => String(v == null ? '' : v).trim();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const bump = () => admin.firestore.FieldValue.increment(1);

const BUCKET_IDS = BUCKET_LAYOUT.map((b) => b.id);

/** 對外呈現的裝置資料（永遠不含 tokenHash）。*/
function presentDevice(id, d, nowMs = Date.now()) {
  const lastSeen = d.lastSeenAt ? d.lastSeenAt.toDate() : null;
  const secondsSinceSeen = lastSeen ? Math.round((nowMs - lastSeen.getTime()) / 1000) : null;
  const online = secondsSinceSeen != null && secondsSinceSeen < DEVICE.offlineAfterSeconds;

  return {
    deviceId: id,
    label: d.label || null,
    status: d.status || 'active',
    classId: d.classId || null,
    className: d.className || null,
    bucketId: d.bucketId || null,
    bucketLabel: d.bucketId ? (BUCKET_LAYOUT.find((b) => b.id === d.bucketId) || {}).label || null : null,
    provisioned: Boolean(d.classId && d.bucketId),
    // 量測參數
    tareG: Number(d.tareG || 0),
    calibrationFactor: Number(d.calibrationFactor || 1),
    zeroOffset: Number(d.zeroOffset || 0),
    configVersion: Number(d.configVersion || 1),
    // 健康狀態
    online,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    secondsSinceSeen,
    batteryPct: d.batteryPct ?? null,
    rssi: d.rssi ?? null,
    firmware: d.firmware || null,
    bootCount: Number(d.bootCount || 0),
    queuedReadings: Number(d.queuedReadings || 0),
    authFailures: Number(d.authFailures || 0),
    notes: d.notes || null,
  };
}

/** GET /api/tech/devices — 機隊清單（含健康摘要）。*/
const listDevices = async (req, res) => {
  try {
    const snap = await db.collection(COL.devices).get();
    const now = Date.now();
    const devices = snap.docs
      .map((d) => presentDevice(d.id, d.data(), now))
      .sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));

    const summary = {
      total: devices.length,
      online: devices.filter((d) => d.online).length,
      offline: devices.filter((d) => !d.online && d.status !== 'disabled').length,
      unprovisioned: devices.filter((d) => !d.provisioned).length,
      disabled: devices.filter((d) => d.status === 'disabled').length,
      lowBattery: devices.filter((d) => d.batteryPct != null && d.batteryPct < 20).length,
      withAuthFailures: devices.filter((d) => d.authFailures > 0).length,
    };

    return res.status(200).json({ success: true, summary, devices, buckets: BUCKET_LAYOUT });
  } catch (error) {
    console.error('取得裝置清單失敗:', error);
    return bad(res, 500, error.message || '取得裝置清單失敗');
  }
};

/**
 * POST /api/tech/devices — 註冊新裝置（或批次註冊）。
 * body: { deviceId, label?, count?, prefix? }
 *
 * token 只會在這裡回傳一次明碼，之後資料庫只留雜湊。
 * 批次註冊時回傳整份清單，技術員可直接貼到燒錄工具或列印標籤。
 */
const registerDevices = async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body.count, 10) || 1, 1), 50);
    const prefix = norm(req.body.prefix) || 'esp32';
    const explicitId = norm(req.body.deviceId);

    if (explicitId && count > 1) {
      return bad(res, 400, '指定 deviceId 時一次只能註冊一台');
    }

    // 批次時自動接續編號，避免人工填號填到重複
    let nextIndex = 1;
    if (!explicitId) {
      const existing = await db.collection(COL.devices).get();
      const used = existing.docs
        .map((d) => d.id)
        .filter((id) => id.startsWith(prefix + '-'))
        .map((id) => parseInt(id.slice(prefix.length + 1), 10))
        .filter((n) => Number.isFinite(n));
      nextIndex = used.length ? Math.max(...used) + 1 : 1;
    }

    const created = [];
    for (let i = 0; i < count; i++) {
      const deviceId = explicitId || `${prefix}-${String(nextIndex + i).padStart(4, '0')}`;
      const ref = db.collection(COL.devices).doc(deviceId);
      if ((await ref.get()).exists) {
        if (explicitId) return bad(res, 409, `裝置 ${deviceId} 已存在`);
        continue;
      }
      const token = generateToken();
      await ref.set({
        deviceId,
        label: norm(req.body.label) || null,
        tokenHash: hashToken(token),
        status: 'active',
        configVersion: 1,
        tareG: 0,
        calibrationFactor: 1,
        zeroOffset: 0,
        sampleIntervalSec: 5,
        heartbeatIntervalSec: 300,
        uploadOnChangeGrams: 50,
        registeredBy: req.user.uid,
        registeredAt: serverTime(),
      });
      // token 明碼只在此刻存在，之後查不回來
      created.push({ deviceId, token });
    }

    return res.status(201).json({
      success: true,
      message: `已註冊 ${created.length} 台裝置`,
      devices: created,
      warning: 'token 只會顯示這一次，請立即寫入韌體或存到安全的地方',
    });
  } catch (error) {
    console.error('註冊裝置失敗:', error);
    return bad(res, 500, error.message || '註冊裝置失敗');
  }
};

/**
 * PATCH /api/tech/devices/:deviceId — 綁定班級/桶別、設定扣重與校正、停用。
 * body: { classId?, bucketId?, tareG?, calibrationFactor?, zeroOffset?, label?,
 *         status?, notes?, sampleIntervalSec?, heartbeatIntervalSec?, uploadOnChangeGrams? }
 */
const updateDevice = async (req, res) => {
  try {
    const ref = db.collection(COL.devices).doc(req.params.deviceId);
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, '查無此裝置');

    const updates = { updatedBy: req.user.uid, updatedAt: serverTime() };
    let affectsMeasurement = false;

    if (req.body.classId !== undefined) {
      const classId = norm(req.body.classId);
      if (classId) {
        const classSnap = await db.collection(COL.classes).doc(classId).get();
        if (!classSnap.exists) return bad(res, 404, '查無此班級');
        updates.classId = classId;
        updates.className = classSnap.data().name || null;
        updates.schoolId = classSnap.data().schoolId || null;
      } else {
        updates.classId = null;
        updates.className = null;
      }
      affectsMeasurement = true;
    }

    if (req.body.bucketId !== undefined) {
      const bucketId = norm(req.body.bucketId);
      if (bucketId && !BUCKET_IDS.includes(bucketId)) {
        return bad(res, 400, `桶別需為 ${BUCKET_IDS.join(' / ')}`);
      }
      updates.bucketId = bucketId || null;
      affectsMeasurement = true;
    }

    // 同一班同一桶只能綁一台，否則同一桶會有兩筆互相打架的讀數
    const targetClass = updates.classId !== undefined ? updates.classId : snap.data().classId;
    const targetBucket = updates.bucketId !== undefined ? updates.bucketId : snap.data().bucketId;
    if (targetClass && targetBucket) {
      const dup = await db.collection(COL.devices)
        .where('classId', '==', targetClass)
        .where('bucketId', '==', targetBucket)
        .get();
      const conflict = dup.docs.find((d) => d.id !== req.params.deviceId && d.data().status !== 'disabled');
      if (conflict) {
        return bad(res, 409, `${conflict.id} 已綁定同一班的同一個桶，請先解除它的綁定`);
      }
    }

    for (const [field, parser] of [
      ['tareG', Number], ['calibrationFactor', Number], ['zeroOffset', Number],
      ['sampleIntervalSec', Number], ['heartbeatIntervalSec', Number], ['uploadOnChangeGrams', Number],
    ]) {
      if (req.body[field] !== undefined) {
        const v = parser(req.body[field]);
        if (!Number.isFinite(v)) return bad(res, 400, `${field} 需為數字`);
        if (field === 'calibrationFactor' && v === 0) return bad(res, 400, '校正係數不可為 0');
        updates[field] = v;
        affectsMeasurement = true;
      }
    }

    if (req.body.label !== undefined) updates.label = norm(req.body.label) || null;
    if (req.body.notes !== undefined) updates.notes = norm(req.body.notes) || null;
    if (req.body.status !== undefined) {
      const status = norm(req.body.status);
      if (!['active', 'disabled', 'maintenance'].includes(status)) {
        return bad(res, 400, 'status 需為 active / maintenance / disabled');
      }
      updates.status = status;
      affectsMeasurement = true;
    }

    // 只要動到量測相關設定就推進版本，裝置下次心跳會重抓
    if (affectsMeasurement) updates.configVersion = bump();

    await ref.set(updates, { merge: true });
    const after = await ref.get();

    return res.status(200).json({
      success: true,
      message: '已更新，裝置下次心跳會套用新設定',
      device: presentDevice(after.id, after.data()),
    });
  } catch (error) {
    console.error('更新裝置失敗:', error);
    return bad(res, 500, error.message || '更新裝置失敗');
  }
};

/**
 * POST /api/tech/devices/:deviceId/tare — 空盆歸零。
 * body: { mode: 'latest' | 'manual', tareG? }
 *
 * latest：把最近一筆讀數的毛重當成盆重（現場放空盆再按一下，最直覺）
 * manual：直接輸入已知盆重
 */
const setTare = async (req, res) => {
  try {
    const ref = db.collection(COL.devices).doc(req.params.deviceId);
    const snap = await ref.get();
    if (!snap.exists) return bad(res, 404, '查無此裝置');

    const mode = norm(req.body.mode) || 'latest';
    let tareG;
    let source;

    if (mode === 'manual') {
      tareG = Number(req.body.tareG);
      if (!Number.isFinite(tareG) || tareG < 0) return bad(res, 400, '請提供有效的盆重（公克）');
      source = '人工輸入';
    } else {
      const readings = await db.collection(COL.deviceReadings)
        .where('deviceId', '==', req.params.deviceId)
        .orderBy('receivedAt', 'desc')
        .limit(1)
        .get();
      if (readings.empty) {
        return bad(res, 400, '這台裝置還沒有任何讀數，請先讓它上傳一筆（或改用手動輸入盆重）');
      }
      const latest = readings.docs[0].data();
      // 毛重就是「盆子本身」的重量（現場應該放空盆）
      tareG = Number(latest.grossG || 0);
      source = `最近一筆讀數（${latest.receivedAt ? latest.receivedAt.toDate().toISOString() : '時間未知'}）`;
    }

    await ref.set({
      tareG: Math.round(tareG * 10) / 10,
      tareSetBy: req.user.uid,
      tareSetAt: serverTime(),
      tareSource: source,
      configVersion: bump(),
    }, { merge: true });

    return res.status(200).json({
      success: true,
      message: `已將盆體扣重設為 ${Math.round(tareG * 10) / 10} g（${source}）`,
      tareG: Math.round(tareG * 10) / 10,
    });
  } catch (error) {
    console.error('設定扣重失敗:', error);
    return bad(res, 500, error.message || '設定扣重失敗');
  }
};

/**
 * POST /api/tech/devices/:deviceId/calibrate — 用已知砝碼算校正係數。
 * body: { knownWeightG, rawWithWeight, rawEmpty? }
 *
 * 係數 = (放砝碼的 raw − 空秤的 raw) / 已知重量
 */
const calibrate = async (req, res) => {
  try {
    const ref = db.collection(COL.devices).doc(req.params.deviceId);
    if (!(await ref.get()).exists) return bad(res, 404, '查無此裝置');

    const known = Number(req.body.knownWeightG);
    const rawWith = Number(req.body.rawWithWeight);
    const rawEmpty = Number(req.body.rawEmpty != null ? req.body.rawEmpty : 0);

    if (!Number.isFinite(known) || known <= 0) return bad(res, 400, '請提供砝碼重量（公克，需大於 0）');
    if (!Number.isFinite(rawWith)) return bad(res, 400, '請提供放上砝碼時的原始讀數');

    const factor = (rawWith - rawEmpty) / known;
    if (!Number.isFinite(factor) || factor === 0) {
      return bad(res, 400, '算出的校正係數無效，請確認原始讀數是否正確');
    }

    await ref.set({
      calibrationFactor: factor,
      zeroOffset: rawEmpty,
      calibratedBy: req.user.uid,
      calibratedAt: serverTime(),
      calibrationNote: `${known}g 砝碼：raw ${rawEmpty} → ${rawWith}`,
      configVersion: bump(),
    }, { merge: true });

    return res.status(200).json({
      success: true,
      message: `校正完成：每公克 ${Math.round(factor * 100) / 100} raw`,
      calibrationFactor: factor,
      zeroOffset: rawEmpty,
    });
  } catch (error) {
    console.error('校正失敗:', error);
    return bad(res, 500, error.message || '校正失敗');
  }
};

/** POST /api/tech/devices/:deviceId/rotate-token — 換發憑證（裝置遺失、維修後回收時用）。*/
const rotateToken = async (req, res) => {
  try {
    const ref = db.collection(COL.devices).doc(req.params.deviceId);
    if (!(await ref.get()).exists) return bad(res, 404, '查無此裝置');

    const token = generateToken();
    await ref.set({
      tokenHash: hashToken(token),
      tokenRotatedBy: req.user.uid,
      tokenRotatedAt: serverTime(),
      authFailures: 0,
    }, { merge: true });

    return res.status(200).json({
      success: true,
      message: '已換發新憑證，舊憑證立即失效',
      deviceId: req.params.deviceId,
      token,
      warning: 'token 只會顯示這一次',
    });
  } catch (error) {
    console.error('換發憑證失敗:', error);
    return bad(res, 500, error.message || '換發憑證失敗');
  }
};

/** GET /api/tech/devices/:deviceId/readings?limit= — 最近讀數（現場排查用）。*/
const listReadings = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const snap = await db.collection(COL.deviceReadings)
      .where('deviceId', '==', req.params.deviceId)
      .orderBy('receivedAt', 'desc')
      .limit(limit)
      .get();

    const readings = snap.docs.map((d) => {
      const r = d.data();
      return {
        readingId: r.readingId,
        date: r.date,
        raw: r.raw,
        grossG: r.grossG,
        tareG: r.tareG,
        netG: r.netG,
        stable: r.stable,
        outOfRange: Boolean(r.outOfRange),
        receivedAt: r.receivedAt ? r.receivedAt.toDate().toISOString() : null,
      };
    });

    return res.status(200).json({ success: true, deviceId: req.params.deviceId, readings });
  } catch (error) {
    console.error('取得讀數失敗:', error);
    return bad(res, 500, error.message || '取得讀數失敗');
  }
};

/** GET /api/tech/health — 機隊健康總覽（給監控頁/巡檢用）。*/
const fleetHealth = async (req, res) => {
  try {
    const [devicesSnap, readingsSnap] = await Promise.all([
      db.collection(COL.devices).get(),
      db.collection(COL.deviceReadings).where('date', '>=', daysAgo(1)).get(),
    ]);

    const now = Date.now();
    const devices = devicesSnap.docs.map((d) => presentDevice(d.id, d.data(), now));
    const readingsByDevice = {};
    readingsSnap.docs.forEach((d) => {
      const r = d.data();
      readingsByDevice[r.deviceId] = (readingsByDevice[r.deviceId] || 0) + 1;
    });

    // 需要人去看的裝置，直接列出來，不用自己從清單裡挑
    const attention = devices
      .filter((d) => d.status !== 'disabled')
      .map((d) => {
        const reasons = [];
        if (!d.provisioned) reasons.push('未綁定班級/桶別');
        if (!d.online) reasons.push(d.lastSeenAt ? '離線' : '從未連線');
        if (d.batteryPct != null && d.batteryPct < 20) reasons.push(`電量 ${d.batteryPct}%`);
        if (d.authFailures > 0) reasons.push(`憑證驗證失敗 ${d.authFailures} 次`);
        if (d.queuedReadings > 20) reasons.push(`離線佇列積壓 ${d.queuedReadings} 筆`);
        if (d.tareG === 0 && d.provisioned) reasons.push('尚未設定盆體扣重');
        if (d.calibrationFactor === 1 && d.provisioned) reasons.push('尚未校正');
        return reasons.length ? { deviceId: d.deviceId, className: d.className, bucketLabel: d.bucketLabel, reasons } : null;
      })
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      date: today(),
      total: devices.length,
      online: devices.filter((d) => d.online).length,
      readingsLast24h: readingsSnap.size,
      silentButProvisioned: devices.filter((d) => d.provisioned && !readingsByDevice[d.deviceId]).map((d) => d.deviceId),
      attention,
    });
  } catch (error) {
    console.error('取得機隊健康失敗:', error);
    return bad(res, 500, error.message || '取得機隊健康失敗');
  }
};

module.exports = {
  listDevices,
  registerDevices,
  updateDevice,
  setTare,
  calibrate,
  rotateToken,
  listReadings,
  fleetHealth,
};
