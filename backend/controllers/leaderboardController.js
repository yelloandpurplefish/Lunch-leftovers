/**
 * 排行榜：個人榜與班級榜。
 *
 *  GET /api/leaderboard?scope=personal|class&period=week|month|term&metric=E|S|reduction&within=school|class
 *
 *  個人榜：週期內**獲得**的幣數（只算正向增減，把幣花掉不該掉名次；
 *          午餐長不能消耗，用淨額會不公平）。預設 E幣、全校範圍。
 *  班級榜：週期內**人均減碳量**（總減碳 ÷ 班級人數），避免大班佔優；
 *          另附總剩食克數與班級幣池供參考。
 *
 * 回應同時保留原本的 `leaderboard` / `myRank` 欄位，他的舊前端不改也能跑；
 * 新欄位 rows/unit/metric 給新的排行榜頁使用。
 *
 * 原版是把 users 全表撈回 Node 端排序（沒有索引、資料一多就爆），
 * 這裡改成用 coin_transactions 與 meal_sessions 依日期區間查詢（見 firestore.indexes.json）。
 */
const { db } = require('../config/firebase');
const { COL, ROLES, COIN_HOLDER_ROLES } = require('../config/schema');
const { daysAgo } = require('../lib/dates');

const bad = (res, status, message) => res.status(status).json({ success: false, message });

const PERIOD_DAYS = { week: 7, month: 30, term: 120 };
const periodDays = (p) => PERIOD_DAYS[p] || PERIOD_DAYS.week;

function round(v, d = 3) {
  const f = Math.pow(10, d);
  return Math.round(Number(v) * f) / f;
}

/** 個人榜：週期內獲得的 E 或 S 幣。*/
async function personalBoard({ coin, since, within, classId, schoolId, myUid, limit }) {
  const snap = await db.collection(COL.coinTx)
    .where('ownerType', '==', 'user')
    .where('coin', '==', coin)
    .where('date', '>=', since)
    .get();

  const gained = new Map();
  snap.docs.forEach((d) => {
    const t = d.data();
    if (Number(t.amount) <= 0) return; // 只算獲得
    gained.set(t.ownerId, (gained.get(t.ownerId) || 0) + Number(t.amount));
  });

  // 取使用者資料以過濾範圍（全校/本班）與顯示名稱
  const userIds = [...gained.keys()];
  const users = new Map();
  for (let i = 0; i < userIds.length; i += 30) {
    const chunk = userIds.slice(i, i + 30);
    const snaps = await db.getAll(...chunk.map((id) => db.collection(COL.users).doc(id)));
    snaps.forEach((s) => {
      if (s.exists) users.set(s.id, s.data());
    });
  }

  const rows = userIds
    .map((id) => ({ id, value: gained.get(id), u: users.get(id) }))
    .filter(({ u }) => {
      if (!u || u.isActive === false) return false;
      if (!COIN_HOLDER_ROLES.includes(u.role)) return false;       // 家長/教師不入榜
      if (within === 'class') return classId && u.classId === classId;
      return !schoolId || u.schoolId === schoolId;
    })
    .map(({ id, value, u }) => ({
      id,
      displayName: u.displayName || '匿名',
      className: u.className || null,
      role: u.role,
      value,
      me: id === myUid,
    }))
    .sort((a, b) => b.value - a.value);

  rows.forEach((r, i) => { r.rank = i + 1; });
  const mine = rows.find((r) => r.me) || null;
  return { rows: rows.slice(0, limit), mine, total: rows.length };
}

/** 班級榜：週期內人均減碳量（另附總剩食與班級幣池）。*/
async function classBoard({ since, schoolId, myClassId, limit }) {
  let q = db.collection(COL.mealSessions).where('date', '>=', since);
  if (schoolId) q = q.where('schoolId', '==', schoolId);
  const snap = await q.get();

  const agg = new Map();
  snap.docs.forEach((d) => {
    const s = d.data();
    if (s.status !== 'done') return;
    const cur = agg.get(s.classId) || { reduced: 0, leftoverG: 0, meals: 0 };
    cur.reduced += Number((s.reduction && s.reduction.reducedCo2e) || 0);
    cur.leftoverG += Number((s.summary && s.summary.totalG) || 0);
    cur.meals += 1;
    agg.set(s.classId, cur);
  });

  const classIds = [...agg.keys()];
  const classes = new Map();
  if (classIds.length) {
    const snaps = await db.getAll(...classIds.map((id) => db.collection(COL.classes).doc(id)));
    snaps.forEach((s) => {
      if (s.exists) classes.set(s.id, s.data());
    });
  }

  const rows = classIds
    .map((id) => {
      const c = classes.get(id) || {};
      const head = Number(c.headcount || 0) || 1;
      const a = agg.get(id);
      return {
        id,
        displayName: c.name ? `${c.grade || ''}年${c.name}班` : id,
        className: c.name || id,
        value: round(a.reduced / head, 3),        // 人均減碳 kgCO2e
        totalReduced: round(a.reduced, 3),
        totalLeftoverG: Math.round(a.leftoverG),
        avgLeftoverPerMealG: Math.round(a.leftoverG / Math.max(1, a.meals)),
        meals: a.meals,
        headcount: Number(c.headcount || 0),
        classCoins: { E: Number(c.eCoin || 0), S: Number(c.sCoin || 0) },
        me: id === myClassId,
      };
    })
    .sort((a, b) => b.value - a.value);

  rows.forEach((r, i) => { r.rank = i + 1; });
  const mine = rows.find((r) => r.me) || null;
  return { rows: rows.slice(0, limit), mine, total: rows.length };
}


/**
 * 個人英雄榜：同一列就看得到 E 幣、S 幣與種樹數，不必在三張榜之間切換。
 *
 * 樹數取自總帳的 `trees` 欄位而不是使用者身上的累計值，
 * 因為榜單是**期間**統計（本週/本月/本學期），累計值只能回答「到目前為止」。
 *
 * 刻意分兩次查 E 與 S：現有索引是 (ownerType, coin, date)，
 * 只用 ownerType + date 範圍查會需要另開一個索引，而這裡多一次查詢就夠了。
 */
async function heroBoard({ since, within, classId, schoolId, myUid, limit, sort }) {
  const agg = new Map();
  const bump = (id, field, amount) => {
    const cur = agg.get(id) || { E: 0, S: 0, trees: 0 };
    cur[field] += amount;
    agg.set(id, cur);
  };

  for (const coin of ['E', 'S']) {
    const snap = await db.collection(COL.coinTx)
      .where('ownerType', '==', 'user')
      .where('coin', '==', coin)
      .where('date', '>=', since)
      .get();
    snap.docs.forEach((d) => {
      const t = d.data();
      const amount = Number(t.amount || 0);
      if (amount > 0) bump(t.ownerId, coin, amount);        // 只算獲得，不扣兌換
      const trees = Number(t.trees || 0);
      if (coin === 'S' && trees > 0) bump(t.ownerId, 'trees', trees);
    });
  }

  const ids = [...agg.keys()];
  const users = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snaps = await db.getAll(...chunk.map((id) => db.collection(COL.users).doc(id)));
    snaps.forEach((s) => {
      if (s.exists) users.set(s.id, s.data());
    });
  }

  const key = ['E', 'S', 'trees'].includes(sort) ? sort : 'trees';
  const rows = ids
    .map((id) => ({ id, ...agg.get(id), u: users.get(id) }))
    .filter(({ u }) => {
      if (!u || u.isActive === false) return false;
      if (!COIN_HOLDER_ROLES.includes(u.role)) return false;      // 家長/教師不入榜
      if (within === 'class') return classId && u.classId === classId;
      return !schoolId || u.schoolId === schoolId;
    })
    .map(({ id, E, S, trees, u }) => ({
      id,
      displayName: u.displayName || '匿名',
      className: u.className || null,
      role: u.role,
      E: Math.round(E),
      S: Math.round(S),
      trees: round(trees, 4),
      // 累計值另外給：英雄榜下方會顯示「你到目前為止一共種了幾棵樹」
      treesLifetime: round(Number(u.treesPlanted || 0), 4),
      value: key === 'trees' ? round(trees, 4) : Math.round(key === 'E' ? E : S),
      me: id === myUid,
    }))
    .sort((a, b) => b.value - a.value || b.trees - a.trees);

  rows.forEach((r, i) => { r.rank = i + 1; });
  const mine = rows.find((r) => r.me) || null;
  return { rows: rows.slice(0, limit), mine, total: rows.length, sort: key };
}

/**
 * GET /api/leaderboard/heroes?period=&within=&sort=&limit=
 */
const getHeroBoard = async (req, res) => {
  try {
    const period = PERIOD_DAYS[req.query.period] ? req.query.period : 'week';
    const within = req.query.within === 'class' ? 'class' : 'school';
    const sort = req.query.sort;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const since = daysAgo(periodDays(period) - 1);

    const result = await heroBoard({
      since, within, sort, limit,
      classId: req.user.classId,
      schoolId: req.user.schoolId,
      myUid: req.user.uid,
    });

    return res.status(200).json({
      success: true,
      period,
      within,
      since,
      sort: result.sort,
      total: result.total,
      rows: result.rows,
      me: result.mine,
    });
  } catch (error) {
    console.error('取得個人英雄榜失敗:', error);
    return bad(res, 500, error.message || '取得個人英雄榜失敗');
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const scope = req.query.scope === 'class' ? 'class' : 'personal';
    const period = PERIOD_DAYS[req.query.period] ? req.query.period : 'week';
    const within = req.query.within === 'class' ? 'class' : 'school';
    const metric = req.query.metric === 'S' ? 'S' : 'E';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const since = daysAgo(periodDays(period) - 1);

    const result = scope === 'class'
      ? await classBoard({ since, schoolId: req.user.schoolId, myClassId: req.user.classId, limit })
      : await personalBoard({
          coin: metric,
          since,
          within,
          classId: req.user.classId,
          schoolId: req.user.schoolId,
          myUid: req.user.uid,
          limit,
        });

    const unit = scope === 'class' ? 'kg 人均減碳' : `${metric}幣`;

    return res.status(200).json({
      success: true,
      scope,
      period,
      within: scope === 'class' ? 'school' : within,
      metric: scope === 'class' ? 'reduction' : metric,
      unit,
      since,
      total: result.total,
      rows: result.rows,
      myRank: result.mine ? { rank: result.mine.rank, score: result.mine.value, value: result.mine.value } : null,
      // 相容舊前端：leaderboard[].score
      leaderboard: result.rows.map((r) => ({
        rank: r.rank,
        displayName: r.displayName,
        score: r.value,
        classId: scope === 'class' ? r.id : undefined,
      })),
    });
  } catch (error) {
    console.error('取得排行榜失敗:', error);
    return bad(res, 500, error.message || '取得排行榜失敗');
  }
};

module.exports = { getLeaderboard, getHeroBoard };
