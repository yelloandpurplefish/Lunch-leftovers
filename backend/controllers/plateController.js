/**
 * 餐盤辨識：學生吃完拍一張自己的餐盤 → 模型判斷剩多少 → 級距決定回饋與 ESG 幣。
 *
 *  · 一人一天一次（使用者指定）：拍過就鎖住，辨識錯了由管理員更正（adminRosterController）
 *  · **照片不存**：只存結果。學生的照片是個資，而系統沒有需要回看照片的功能
 *  · 不供餐的日子不收
 *  · 結果、餘額、總帳在同一個 transaction 裡寫（lib/plates.js）
 *
 * 老師不再逐生勾選「吃完」——當天吃得怎麼樣一律以這裡的結果為準；
 * 老師可以看本班的結果（getClassPlates），但不能改。
 */
const { db } = require('../config/firebase');
const { COL, ROLES, PLATE } = require('../config/schema');
const { today, isYmd, daysAgo } = require('../lib/dates');
const { getDayMenu } = require('../lib/dailyMenu');
const plateModel = require('../lib/plateModel');
const plates = require('../lib/plates');
const { targetClassId } = require('../middleware/auth');

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

/** 四級的說明與額度，前端用來顯示「光盤 +10、剩一點 +6…」。 */
async function tierTable() {
  const rewards = await plates.rewardTable();
  return PLATE.tiers.map((t) => ({
    level: t.level, label: t.label, minPct: t.minPct, maxPct: t.maxPct, reward: rewards[t.level],
  }));
}

/** 某位學生近 N 天的結果（新到舊）。 */
async function recentOf(userId, days) {
  const since = daysAgo(days - 1);
  const snap = await db.collection(COL.plateScans)
    .where('userId', '==', userId)
    .orderBy('date', 'desc')
    .limit(days)
    .get();
  return snap.docs.filter((d) => d.data().date >= since).map((d) => plates.present(d.id, d.data()));
}

function summarizeRecent(list, days) {
  const clean = list.filter((x) => x.level === 'clean').length;
  return { days, scannedDays: list.length, cleanDays: clean };
}

/** GET /api/plate/today — 今天的結果、近 7 天、模型能不能用、四級額度。 */
const getTodayScan = async (req, res) => {
  try {
    const date = today();
    const [menu, snap, recent, tiers] = await Promise.all([
      getDayMenu(date),
      plates.scanRef(req.user.uid, date).get(),
      recentOf(req.user.uid, 7),
      tierTable(),
    ]);
    return res.status(200).json({
      success: true,
      date,
      served: menu.served,
      model: plateModel.modelStatus(),
      scan: snap.exists ? plates.present(snap.id, snap.data()) : null,
      recent,
      stats: summarizeRecent(recent, 7),
      tiers,
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

    // 先擋已經拍過的：省掉一次辨識。真正的保證在 transaction 裡（併發時第二筆會被擋）
    if ((await plates.scanRef(req.user.uid, date).get()).exists) {
      return bad(res, 409, '今天已經拍過了，一天只能拍一次。結果有誤請找管理員更正。');
    }

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

    const written = await plates.writeResult({
      userId: req.user.uid,
      date,
      mode: 'scan',
      leftoverPct: result.leftoverRatio * 100,
      model: { mode: result.mode, version: result.modelVersion, label: result.label, confidence: result.confidence },
    });

    const saved = await plates.scanRef(req.user.uid, date).get();
    const scan = plates.present(saved.id, saved.data());
    return res.status(200).json({
      success: true,
      message: written.coinsAwarded > 0
        ? `${scan.feedback.title}　ESG 幣 +${written.coinsAwarded}`
        : scan.feedback.title,
      scan,
      model: plateModel.modelStatus(),
    });
  } catch (error) {
    if (error.status && error.status < 500) return bad(res, error.status, error.message);
    console.error('餐盤辨識失敗:', error);
    return bad(res, 500, error.message || '餐盤辨識失敗');
  }
};

/**
 * GET /api/plate/class?date=&classId=
 * 老師看本班（管理員可指定班級）某天每位學生的結果。唯讀。
 */
const getClassPlates = async (req, res) => {
  try {
    const classId = targetClassId(req);
    if (classId === null) return bad(res, 403, '只能看自己班級');
    if (!classId) return bad(res, 400, '此帳號尚未編入班級');
    const date = isYmd(req.query.date) ? req.query.date : today();

    const [classSnap, studentsSnap, scansSnap] = await Promise.all([
      db.collection(COL.classes).doc(classId).get(),
      db.collection(COL.users).where('classId', '==', classId).where('role', '==', ROLES.STUDENT).get(),
      db.collection(COL.plateScans).where('classId', '==', classId).where('date', '==', date).get(),
    ]);
    if (!classSnap.exists) return bad(res, 404, '查無此班級');
    const byUser = new Map(scansSnap.docs.map((d) => [d.data().userId, plates.present(d.id, d.data())]));
    const leaderId = classSnap.data().lunchLeaderUserId || null;

    const rows = studentsSnap.docs
      .filter((d) => d.data().isActive !== false)
      .map((d) => ({
        userId: d.id,
        seatNo: d.data().seatNo || '',
        displayName: d.data().displayName || '',
        isLunchLeader: d.id === leaderId,
        scan: byUser.get(d.id) || null,
      }))
      .sort((a, b) => String(a.seatNo).localeCompare(String(b.seatNo), 'zh-Hant', { numeric: true }));

    const counts = {};
    for (const t of PLATE.tiers) counts[t.level] = rows.filter((r) => r.scan && r.scan.level === t.level).length;
    return res.status(200).json({
      success: true,
      date,
      classId,
      className: classSnap.data().name || null,
      rows,
      summary: { total: rows.length, scanned: rows.filter((r) => r.scan).length, ...counts },
      tiers: await tierTable(),
    });
  } catch (error) {
    console.error('取得班級餐盤結果失敗:', error);
    return bad(res, 500, error.message || '取得班級餐盤結果失敗');
  }
};

module.exports = { getTodayScan, scanPlate, getClassPlates, decodeImage, recentOf, summarizeRecent, tierTable };
