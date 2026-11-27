/**
 * 個人 ESG 幣排行榜（英雄榜）。
 *
 *  GET /api/leaderboard?period=week|month|term&within=school|class&limit=
 *
 * 排的是週期內**獲得**的 ESG（只算正向增減）：把幣花掉不該掉名次。
 * 同一列附上各來源（拍餐盤、家長簽到、管理員調整）的拆解。
 *
 * 用 coin_transactions 依日期區間查（索引 ownerType, coin, date），
 * 不把 users 全表撈回 Node 端排序。
 */
const { db } = require('../config/firebase');
const { COL, COIN_HOLDER_ROLES, COIN_SOURCES, ESG } = require('../config/schema');
const { daysAgo } = require('../lib/dates');

const bad = (res, status, message) => res.status(status).json({ success: false, message });

const PERIOD_DAYS = { week: 7, month: 30, term: 120 };

/** 期間內每位使用者獲得的 ESG（只算正數）與各來源拆解。 */
async function earnedSince(since) {
  const snap = await db.collection(COL.coinTx)
    .where('ownerType', '==', 'user')
    .where('coin', '==', ESG)
    .where('date', '>=', since)
    .get();

  const agg = new Map();
  snap.docs.forEach((d) => {
    const t = d.data();
    const amount = Number(t.amount || 0);
    // 對帳補登只是讓總帳與餘額一致，不是這段期間「賺到」的
    if (amount <= 0 || t.refType === 'reconcile') return;
    const cur = agg.get(t.ownerId) || { ESG: 0, bySource: {} };
    cur.ESG += amount;
    if (t.source && COIN_SOURCES[t.source]) cur.bySource[t.source] = (cur.bySource[t.source] || 0) + amount;
    agg.set(t.ownerId, cur);
  });
  return agg;
}

/** 一次取多位使用者（getAll 一次最多 30 筆）。 */
async function loadUsers(ids) {
  const users = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snaps = await db.getAll(...chunk.map((id) => db.collection(COL.users).doc(id)));
    snaps.forEach((s) => { if (s.exists) users.set(s.id, s.data()); });
  }
  return users;
}

function inScope(u, { within, classId, schoolId }) {
  if (!u || u.isActive === false) return false;
  if (!COIN_HOLDER_ROLES.includes(u.role)) return false;        // 只有學生入榜
  if (within === 'class') return Boolean(classId) && u.classId === classId;
  return !schoolId || u.schoolId === schoolId;
}

const getLeaderboard = async (req, res) => {
  try {
    const period = PERIOD_DAYS[req.query.period] ? req.query.period : 'week';
    const within = req.query.within === 'class' ? 'class' : 'school';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const since = daysAgo(PERIOD_DAYS[period] - 1);

    const agg = await earnedSince(since);
    const ids = [...agg.keys()];
    const users = await loadUsers(ids);
    const scope = { within, classId: req.user.classId, schoolId: req.user.schoolId };

    const rows = ids
      .map((id) => ({ id, a: agg.get(id), u: users.get(id) }))
      .filter(({ u }) => inScope(u, scope))
      .map(({ id, a, u }) => ({
        id,
        displayName: u.displayName || '匿名',
        className: u.className || null,
        ESG: Math.round(a.ESG),
        bySource: Object.fromEntries(Object.entries(a.bySource).map(([k, v]) => [k, Math.round(v)])),
        me: id === req.user.uid,
      }))
      .filter((r) => r.ESG > 0)
      .sort((a, b) => b.ESG - a.ESG);

    rows.forEach((r, i) => { r.rank = i + 1; });

    return res.status(200).json({
      success: true,
      period,
      within,
      since,
      total: rows.length,
      rows: rows.slice(0, limit),
      me: rows.find((r) => r.me) || null,
      sources: COIN_SOURCES,
    });
  } catch (error) {
    console.error('取得排行榜失敗:', error);
    return bad(res, 500, error.message || '取得排行榜失敗');
  }
};

module.exports = { getLeaderboard };
