/**
 * ESG 幣記帳：**所有** ESG 的增減都要走這裡，不要在 controller 直接 increment。
 *
 * ## 一種幣、三個來源
 *
 * 餘額只有 esgCoin 一個欄位。但每一筆總帳都標出來源：
 *   source:'E'  營養（吃進去的蛋白質與膳食纖維）
 *   source:'S'  減碳（比全校平均少浪費，換算成樹）
 *   source:'G'  感謝（老師確認完食）
 * 呼叫端照樣傳 { E, S, G }，意思是「從各來源各得多少 ESG」。
 * 這樣餘額是一個數字，而「這些 ESG 從哪裡來」仍查得到。
 *
 * ## 規則（config/schema.js 為準）
 *  - 家長沒有幣系統：任何試圖給家長記幣的呼叫都會被擋下。
 *  - 午餐長只累積不消耗：spendUser 只允許 COIN_SPENDER_ROLES。
 *  - 班級增長「全額」加給班上每位學生；班級池自己也記一份。
 *  - 每一筆增減都寫進 coin_transactions 總帳，餘額才有稽核依據。
 *
 * ## 舊資料
 *  合併前的分錄記的是 coin:'E'|'S'|'G'（舊單位），保留不改寫——總帳是稽核資料。
 *  需要跟新分錄一起加總時（例如英雄榜），用 legacyToEsg() 換算。
 */
const { db, admin } = require('../config/firebase');
const {
  COL, ROLES, COIN_HOLDER_ROLES, COIN_SPENDER_ROLES, ESG, esgFactor,
} = require('../config/schema');
const { today } = require('./dates');

const inc = (n) => admin.firestore.FieldValue.increment(n);
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

/** 餘額欄位。使用者與班級池都用這一個。 */
const FIELD = 'esgCoin';

/** 來源的固定順序：總帳分錄順序穩定，測試才好比對。 */
const SOURCES = ['E', 'S', 'G'];

const SOURCE_LABEL = { E: '營養', S: '減碳', G: '感謝' };

const pos = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

function txEntry({ ownerType, ownerId, amount, source, reason, refType, refId, date, trees }) {
  return {
    ownerType,           // 'user' | 'class'
    ownerId,
    coin: ESG,           // 一律 ESG；合併前的舊分錄才會是 E/S/G
    source: source || null,   // 'E' | 'S' | 'G' | null（消耗類沒有來源）
    amount,              // 正=獲得、負=消耗
    reason,
    refType: refType || null,
    refId: refId || null,
    date: date || today(),
    /**
     * 這筆對應幾棵樹（只有減碳來源會有）。
     * 存在總帳而不是只靠累計欄位，英雄榜才能問「這學期種了幾棵樹」；
     * 而且樹→幣的放大常數可在面板調整，事後用幣數回推樹數會算錯歷史。
     */
    trees: Number(trees || 0),
    createdAt: serverTime(),
  };
}

/**
 * 把一筆分錄換成 ESG 數量。新分錄原樣回傳；合併前的 E/S/G 舊分錄乘上換算係數。
 * 英雄榜、個人榜這種「跨越合併前後」的加總要用這個，不然新舊單位會混在一起。
 */
function legacyToEsg(tx) {
  const amount = Number(tx.amount || 0);
  if (!tx.coin || tx.coin === ESG) return amount;
  return amount * esgFactor(tx.coin);
}

/** 舊分錄的來源就是它的幣別；新分錄看 source 欄位。 */
function sourceOf(tx) {
  if (tx.coin && tx.coin !== ESG) return tx.coin;
  return tx.source || null;
}

/**
 * 個人加幣。
 * @returns {Promise<{E:number,S:number,G:number,total:number}>} 各來源實際發出的量
 */
async function awardUser({ userId, E = 0, S = 0, G = 0, reason, refType, refId, date, role }) {
  if (!userId) throw new Error('awardUser 缺少 userId');
  const want = { E: pos(E), S: pos(S), G: pos(G) };
  const total = want.E + want.S + want.G;
  if (total <= 0) return { E: 0, S: 0, G: 0, total: 0 };

  // 家長不持幣：擋在記帳層，避免任何呼叫端漏判
  const holderRole = role || (await getRole(userId));
  if (!COIN_HOLDER_ROLES.includes(holderRole)) {
    throw new Error(`角色 ${holderRole} 沒有幣系統，不可記幣`);
  }

  const batch = db.batch();
  batch.set(db.collection(COL.users).doc(userId), { [FIELD]: inc(total) }, { merge: true });
  for (const source of SOURCES) {
    if (want[source] > 0) {
      batch.set(db.collection(COL.coinTx).doc(), txEntry({
        ownerType: 'user', ownerId: userId, amount: want[source], source,
        reason, refType, refId, date,
      }));
    }
  }
  await batch.commit();
  return { ...want, total };
}

/**
 * 班級加幣：班級池 + **全額**加給班上每位持幣成員（學生與午餐長）。
 *
 * @param {number} treesPerCapita 每位學生記到自己名下的樹（個人貢獻）
 * @param {number} treesClass     班級池記錄的樹（= 人均 × 供餐份數，真實環境效益）
 *
 * 兩個樹數刻意用不同基數：班級數字要反映真實的環境效益（以供餐份數計），
 * 個人數字是「我這一份的貢獻」。已註冊人數可能少於供餐份數，
 * 所以兩者加總不會相等——這是不同的統計口徑，不是帳不平。
 */
async function awardClassAndMembers({
  classId, E = 0, S = 0, treesPerCapita = 0, treesClass = 0,
  reason, refType, refId, date,
}) {
  if (!classId) throw new Error('awardClassAndMembers 缺少 classId');
  const e = pos(E);
  const s = pos(S);
  const total = e + s;
  if (total <= 0 && treesPerCapita <= 0 && treesClass <= 0) {
    return { members: 0, perMember: { E: 0, S: 0, total: 0, trees: 0 } };
  }

  const membersSnap = await db.collection(COL.users)
    .where('classId', '==', classId)
    .where('role', 'in', COIN_HOLDER_ROLES)
    .get();

  const d = date || today();
  const batch = db.batch();

  // 班級池
  const classUpdates = {};
  if (total > 0) classUpdates[FIELD] = inc(total);
  if (treesClass > 0) classUpdates.treesPlanted = inc(treesClass);
  batch.set(db.collection(COL.classes).doc(classId), classUpdates, { merge: true });

  // 減碳的分錄即使幣數進位成 0 也要留：樹數本身是要展示的成果，
  // 若因為當餐只省下 0.4 枚就整筆不記，累積樹數會一直漏掉小數。
  for (const [source, amount, trees] of [['E', e, 0], ['S', s, treesClass]]) {
    if (amount > 0 || trees > 0) {
      batch.set(db.collection(COL.coinTx).doc(), txEntry({
        ownerType: 'class', ownerId: classId, amount, source, trees,
        reason, refType, refId, date: d,
      }));
    }
  }

  // 每位成員（全額）
  membersSnap.docs.forEach((doc) => {
    const updates = {};
    if (total > 0) updates[FIELD] = inc(total);
    if (treesPerCapita > 0) updates.treesPlanted = inc(treesPerCapita);
    batch.set(doc.ref, updates, { merge: true });
    for (const [source, amount, trees] of [['E', e, 0], ['S', s, treesPerCapita]]) {
      if (amount > 0 || trees > 0) {
        batch.set(db.collection(COL.coinTx).doc(), txEntry({
          ownerType: 'user', ownerId: doc.id, amount, source, trees,
          reason: `${reason}（班級共享）`, refType, refId, date: d,
        }));
      }
    }
  });

  await batch.commit();
  return {
    members: membersSnap.size,
    perMember: { E: e, S: s, total, trees: treesPerCapita },
    classTrees: treesClass,
  };
}

/**
 * 個人消耗（兌換／抽獎）。以 transaction 讀餘額再扣，避免併發超扣。
 * 午餐長與家長會被擋下。
 *
 * coin 參數保留是為了相容舊呼叫；只接受 'ESG'（或不給）。
 */
async function spendUser({ userId, coin = ESG, amount, reason, refType, refId, date }) {
  if (coin !== ESG) throw new Error(`未知幣別 ${coin}（已整合為 ESG 幣）`);
  const amt = Math.abs(Number(amount) || 0);
  if (amt <= 0) throw new Error('消耗金額需為正數');

  const userRef = db.collection(COL.users).doc(userId);

  const balanceAfter = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('使用者不存在');
    const data = snap.data();

    if (!COIN_SPENDER_ROLES.includes(data.role)) {
      const err = new Error(
        data.role === ROLES.LUNCH_LEADER
          ? '午餐長專區不提供兌換與抽獎'
          : '此身份沒有兌換與抽獎功能'
      );
      err.status = 403;
      throw err;
    }

    const current = Number(data[FIELD] || 0);
    if (current < amt) {
      const err = new Error(`ESG 幣不足（需 ${amt}，餘 ${current}）`);
      err.status = 409;
      throw err;
    }

    tx.update(userRef, { [FIELD]: current - amt });
    tx.set(db.collection(COL.coinTx).doc(), txEntry({
      ownerType: 'user', ownerId: userId, amount: -amt, source: null,
      reason, refType, refId, date,
    }));
    return current - amt;
  });

  return { coin: ESG, spent: amt, balanceAfter };
}

/**
 * 沖銷先前的發幣（例如教師誤點「吃完」後取消勾選）。
 * 以 transaction 讀餘額再扣，並在 0 處夾住——學生可能已經把幣花掉，
 * 不可讓餘額變成負數；實際沖銷多少會寫在總帳裡，帳目仍可追。
 * 餘額只有一個，夾住時依 E→S→G 的順序分攤到各來源。
 */
async function reverseAward({ userId, E = 0, S = 0, G = 0, reason, refType, refId, date }) {
  const wanted = { E: pos(E), S: pos(S), G: pos(G) };
  const total = wanted.E + wanted.S + wanted.G;
  if (total <= 0) return { E: 0, S: 0, G: 0, total: 0 };
  const userRef = db.collection(COL.users).doc(userId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { E: 0, S: 0, G: 0, total: 0 };
    const current = Number(snap.data()[FIELD] || 0);
    let budget = Math.min(current, total);
    const take = Math.min(current, total);

    const applied = { E: 0, S: 0, G: 0 };
    for (const source of SOURCES) {
      const t = Math.min(wanted[source], budget);
      applied[source] = t;
      budget -= t;
    }

    if (take > 0) {
      tx.update(userRef, { [FIELD]: current - take });
      for (const source of SOURCES) {
        if (applied[source] > 0) {
          tx.set(db.collection(COL.coinTx).doc(), txEntry({
            ownerType: 'user', ownerId: userId, amount: -applied[source], source,
            reason, refType, refId, date,
          }));
        }
      }
    }
    return { ...applied, total: take };
  });
}

async function getRole(userId) {
  const snap = await db.collection(COL.users).doc(userId).get();
  return snap.exists ? snap.data().role : null;
}

/** 個人餘額 + 最近異動（供「我的」頁）。*/
async function userCoinSummary(userId, { recentLimit = 15 } = {}) {
  const userSnap = await db.collection(COL.users).doc(userId).get();
  const u = userSnap.exists ? userSnap.data() : {};
  const snap = await db.collection(COL.coinTx)
    .where('ownerType', '==', 'user')
    .where('ownerId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(recentLimit)
    .get();

  const recent = snap.docs.map((d) => {
    const t = d.data();
    return {
      id: d.id,
      coin: ESG,
      source: sourceOf(t),
      amount: Math.round(legacyToEsg(t) * 100) / 100,
      legacy: Boolean(t.coin && t.coin !== ESG),
      reason: t.reason,
      date: t.date,
      createdAt: t.createdAt ? t.createdAt.toDate().toISOString() : null,
    };
  });

  return { balance: { ESG: Number(u[FIELD] || 0) }, recent };
}

module.exports = {
  FIELD,
  SOURCES,
  SOURCE_LABEL,
  legacyToEsg,
  sourceOf,
  awardUser,
  awardClassAndMembers,
  spendUser,
  reverseAward,
  userCoinSummary,
};
