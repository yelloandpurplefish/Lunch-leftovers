/**
 * 餐盤結果與它對應的 ESG 幣。
 *
 * 一位學生一天一筆（plate_scans/{日期_學生id}），結果決定當天拿多少 ESG。
 *
 * ## 一致性
 *
 * 「結果」「餘額」「總帳」三件事永遠在**同一個 transaction** 裡寫：
 *   · 學生拍照：已經有結果就拒絕（一天一次），沒有就寫結果並發幣
 *   · 管理員更正：改結果，餘額只補差額（例如從「剩一點 +6」改成「光盤 +10」就補 4）
 *   · 管理員清除：刪掉結果並收回當初發的幣，學生可以重拍
 * 每筆結果都記著 coinsAwarded（這筆結果實際發了多少），差額才算得準——
 * 不能用「現在的設定值」去推當初發了多少，因為額度可能在中途被調過。
 *
 * 收回時在 0 處夾住：學生可能已經把幣花掉，不追成負數；實際收回多少寫在總帳裡。
 */
const { db, admin } = require('../config/firebase');
const { COL, ids, PLATE, plateTier, COIN_HOLDER_ROLES } = require('../config/schema');
const { getSettings } = require('./settings');
const { applyInTx } = require('./coins');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (status, message) => Object.assign(new Error(message), { status });

/** 目前採用的四級額度 { clean, little, half, most }。 */
async function rewardTable() {
  const s = await getSettings();
  const r = (s.plate && s.plate.rewards) || {};
  const out = {};
  for (const t of PLATE.tiers) {
    const v = Number(r[t.level]);
    out[t.level] = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
  return out;
}

const scanRef = (userId, date) => db.collection(COL.plateScans).doc(ids.plateScan(date, userId));

/**
 * 寫入（或改寫）某位學生某天的餐盤結果，並把幣調整到這個結果該給的量。
 *
 * @param {object} p
 * @param {'scan'|'override'} p.mode  scan＝學生自己拍（已有結果就拒絕）；override＝管理員更正
 * @param {number} p.leftoverPct      0–100
 * @param {object} [p.model]          { mode, version, label, confidence }（學生拍照才有）
 * @param {string} [p.by]             操作者 uid（管理員更正時）
 * @param {string} [p.note]           管理員更正的原因
 */
async function writeResult({ userId, date, mode, leftoverPct, model = null, by = null, note = '' }) {
  const pct = Math.min(100, Math.max(0, Math.round(Number(leftoverPct))));
  if (!Number.isFinite(pct)) throw fail(400, '剩餘百分比需為 0–100 的數字');
  const tier = plateTier(pct);
  const rewards = await rewardTable();
  const userRef = db.collection(COL.users).doc(userId);
  const ref = scanRef(userId, date);

  return db.runTransaction(async (tx) => {
    const [userSnap, prevSnap] = await Promise.all([tx.get(userRef), tx.get(ref)]);
    if (!userSnap.exists) throw fail(404, '查無此學生');
    const user = userSnap.data();
    if (!COIN_HOLDER_ROLES.includes(user.role)) throw fail(400, '只有學生有餐盤紀錄');
    const prev = prevSnap.exists ? prevSnap.data() : null;
    if (mode === 'scan' && prev) {
      throw fail(409, '今天已經拍過了，一天只能拍一次。結果有誤請找管理員更正。');
    }

    const had = prev ? Number(prev.coinsAwarded || 0) : 0;
    const applied = applyInTx(tx, {
      userRef, user,
      delta: rewards[tier.level] - had,
      clampAtZero: true,
      source: 'plate',
      reason: mode === 'scan'
        ? `拍餐盤：${tier.label}（剩 ${pct}%）`
        : `管理員更正餐盤結果為「${tier.label}」（剩 ${pct}%）${note ? '：' + note : ''}`,
      refType: 'plate_scan',
      refId: ref.id,
      date,
      by,
    });

    const doc = {
      date,
      userId,
      classId: user.classId || null,
      schoolId: user.schoolId || null,
      leftoverPct: pct,
      level: tier.level,
      label: tier.label,
      coinsAwarded: had + applied,
      updatedAt: serverTime(),
    };
    if (mode === 'scan') {
      Object.assign(doc, {
        source: 'model',
        model: model ? { mode: model.mode || null, version: model.version || null } : null,
        modelLabel: model ? model.label || null : null,
        confidence: model && model.confidence != null ? model.confidence : null,
        scannedAt: serverTime(),
      });
      tx.set(ref, doc);
    } else {
      Object.assign(doc, {
        source: 'admin',
        overriddenBy: by,
        overriddenAt: serverTime(),
        note: String(note || '').slice(0, 200),
      });
      // 模型原本的判定留著：之後校正模型時，「被人改掉的那些」正是最有用的資料
      if (prev && prev.source === 'model') {
        doc.modelResult = { leftoverPct: prev.leftoverPct, level: prev.level, confidence: prev.confidence ?? null };
      }
      tx.set(ref, doc, { merge: true });
    }
    return { tier, pct, coinsAwarded: had + applied, delta: applied, rewards };
  });
}

/** 管理員清除某天的結果：收回當初發的幣，學生可以重拍。 */
async function clearResult({ userId, date, by, note = '' }) {
  const userRef = db.collection(COL.users).doc(userId);
  const ref = scanRef(userId, date);
  return db.runTransaction(async (tx) => {
    const [userSnap, prevSnap] = await Promise.all([tx.get(userRef), tx.get(ref)]);
    if (!prevSnap.exists) throw fail(404, '這天沒有餐盤紀錄');
    const prev = prevSnap.data();
    let applied = 0;
    const holder = userSnap.exists && COIN_HOLDER_ROLES.includes(userSnap.data().role);
    if (holder && Number(prev.coinsAwarded || 0) > 0) {
      applied = applyInTx(tx, {
        userRef, user: userSnap.data(),
        delta: -Number(prev.coinsAwarded || 0),
        clampAtZero: true,
        source: 'plate',
        reason: `管理員清除 ${date} 的餐盤結果${note ? '：' + note : ''}`,
        refType: 'plate_scan',
        refId: ref.id,
        date,
        by,
      });
    }
    tx.delete(ref);
    return { reclaimed: -applied };
  });
}

/** 對外的單筆結果。 */
function present(id, d) {
  if (!d) return null;
  const tier = plateTier(d.leftoverPct);
  const at = (v) => (v && v.toDate ? v.toDate().toISOString() : null);
  return {
    scanId: id,
    date: d.date,
    leftoverPct: Number(d.leftoverPct || 0),
    level: tier.level,
    label: tier.label,
    feedback: { level: tier.level, title: tier.title, message: tier.message },
    coinsAwarded: Number(d.coinsAwarded || 0),
    source: d.source || 'model',
    stub: Boolean(d.model && d.model.mode === 'stub'),
    note: d.note || null,
    scannedAt: at(d.scannedAt) || at(d.overriddenAt),
  };
}

module.exports = { rewardTable, writeResult, clearResult, present, scanRef };
