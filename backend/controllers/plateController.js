/**
 * 學生的個人餐盤辨識：吃完拍一張自己的餐盤 → 模型判斷剩多少 → 依剩餘量給回饋。
 *
 *  · 一人一天一筆（plate_scans/{日期_學生id}），重拍會覆蓋並把 attempts +1
 *  · **照片不存**：只存辨識結果。學生的照片是個資，而這一輪沒有需要回看照片的功能
 *  · 不供餐的日子不收
 *
 * ESG 幣：這一輪**不發**。發多少、重拍要不要鎖、跟老師勾選的「吃完」怎麼搭配，
 * 都等下一輪模型回傳定下來再決定，到時從 scanPlate 結尾接上 lib/coins.js 的 awardUser。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, PLATE } = require('../config/schema');
const { today } = require('../lib/dates');
const { getDayMenu } = require('../lib/dailyMenu');
const plateModel = require('../lib/plateModel');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const bad = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/**
 * 前端送來的照片（data URL 或純 base64）→ Buffer。
 * 只收 JPEG / PNG / WebP，認的是檔頭而不是宣稱的類型。
 */
function decodeImage(raw) {
  if (typeof raw !== 'string' || !raw) return { error: '請附上一張餐盤照片' };
  const base64 = raw.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return { error: '照片格式不正確' };
  // 先用長度估算，太大的就不必真的解碼
  if (Math.floor(base64.length * 3 / 4) > PLATE.maxImageBytes) {
    return { error: `照片太大了（上限 ${Math.round(PLATE.maxImageBytes / 1024 / 1024)} MB）` };
  }
  const buf = Buffer.from(base64, 'base64');
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return { error: '只接受 JPEG、PNG 或 WebP 照片' };
  return { buffer: buf };
}

/** 剩餘比例 → 回饋（級距在 config/schema.js 的 PLATE.feedback）。 */
function feedbackFor(ratio) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  const tier = PLATE.feedback.find((t) => r <= t.maxRatio) || PLATE.feedback[PLATE.feedback.length - 1];
  return { level: tier.level, title: tier.title, message: tier.message };
}

function presentScan(id, d) {
  if (!d) return null;
  return {
    scanId: id,
    date: d.date,
    leftoverPct: Math.round(Number(d.leftoverRatio || 0) * 100),
    label: d.label || null,
    confidence: d.confidence == null ? null : d.confidence,
    feedback: feedbackFor(d.leftoverRatio),
    stub: d.model ? d.model.mode === 'stub' : false,
    attempts: Number(d.attempts || 0),
    scannedAt: d.scannedAt && d.scannedAt.toDate ? d.scannedAt.toDate().toISOString() : null,
  };
}

/** GET /api/plate/today — 今天拍過了沒、模型能不能用、今天有沒有供餐。 */
const getTodayScan = async (req, res) => {
  try {
    const date = today();
    const [menu, snap] = await Promise.all([
      getDayMenu(date),
      db.collection(COL.plateScans).doc(ids.plateScan(date, req.user.uid)).get(),
    ]);
    return res.status(200).json({
      success: true,
      date,
      served: menu.served,
      model: plateModel.modelStatus(),
      scan: snap.exists ? presentScan(snap.id, snap.data()) : null,
    });
  } catch (error) {
    console.error('取得今日餐盤紀錄失敗:', error);
    return bad(res, 500, error.message || '取得今日餐盤紀錄失敗');
  }
};

/**
 * POST /api/plate/scan
 * body: { image }  data URL 或 base64（前端會先縮到長邊 1024px）
 */
const scanPlate = async (req, res) => {
  try {
    const date = today();
    const menu = await getDayMenu(date);
    if (!menu.served) return bad(res, 409, '今天沒有供餐，不需要拍餐盤');

    const decoded = decodeImage(req.body && req.body.image);
    if (decoded.error) return bad(res, 400, decoded.error);

    let result;
    try {
      result = await plateModel.analyzePlate(decoded.buffer);
    } catch (err) {
      if (err.status === 503 || err.status === 502) {
        return bad(res, err.status, err.message, { model: plateModel.modelStatus() });
      }
      throw err;
    }

    const ref = db.collection(COL.plateScans).doc(ids.plateScan(date, req.user.uid));
    const existed = (await ref.get()).exists;
    await ref.set({
      date,
      userId: req.user.uid,
      classId: req.user.classId || null,
      schoolId: req.user.schoolId || null,
      leftoverRatio: result.leftoverRatio,
      label: result.label,
      confidence: result.confidence,
      model: { mode: result.mode, version: result.modelVersion },
      attempts: admin.firestore.FieldValue.increment(1),
      scannedAt: serverTime(),
      ...(existed ? {} : { firstScannedAt: serverTime() }),
    }, { merge: true });

    const saved = await ref.get();
    const scan = presentScan(saved.id, saved.data());
    return res.status(200).json({
      success: true,
      message: scan.feedback.title,
      scan,
      model: plateModel.modelStatus(),
    });
  } catch (error) {
    console.error('餐盤辨識失敗:', error);
    return bad(res, error.status || 500, error.message || '餐盤辨識失敗');
  }
};

module.exports = { getTodayScan, scanPlate, decodeImage, feedbackFor };
