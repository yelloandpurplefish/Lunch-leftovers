/**
 * ESG 幣記帳：ESG 的增減都要走這裡，不要在 controller 直接 increment。
 * （唯一的例外是兌換：扣幣與扣庫存必須在同一個 transaction，見 exchangeController。）
 *
 * ## 一種幣、三個來源
 *
 * 餘額只有 users.esgCoin 一個欄位。但每一筆獲得都標出來源：
 *   source:'E'  營養
 *   source:'S'  減碳
 *   source:'G'  感謝
 * 呼叫端傳 { E, S, G }，意思是「從各來源各得多少 ESG」。
 *
 * ## 規則（config/schema.js 為準）
 *  - 只有學生持幣（COIN_HOLDER_ROLES）。午餐長也是學生，能累積也能消耗。
 *  - 家長、教師沒有幣系統：任何試圖記幣給他們的呼叫都會被擋下。
 *  - 每一筆增減都寫進 coin_transactions 總帳，餘額才有稽核依據。
 */
const { db, admin } = require('../config/firebase');
const { COL, COIN_HOLDER_ROLES, ESG } = require('../config/schema');
const { today } = require('./dates');

const inc = (n) => admin.firestore.FieldValue.increment(n);
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

/** 餘額欄位。 */
const FIELD = 'esgCoin';

/** 來源的固定順序：總帳分錄順序穩定，測試才好比對。 */
const SOURCES = ['E', 'S', 'G'];

const pos = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

function txEntry({ ownerId, amount, source, reason, refType, refId, date }) {
  return {
    ownerType: 'user',
    ownerId,
    coin: ESG,
    source: source || null,   // 'E' | 'S' | 'G' | null（消耗類沒有來源）
    amount,                   // 正=獲得、負=消耗
    reason,
    refType: refType || null,
    refId: refId || null,
    date: date || today(),
    createdAt: serverTime(),
  };
}

async function getRole(userId) {
  const snap = await db.collection(COL.users).doc(userId).get();
  return snap.exists ? snap.data().role : null;
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

  // 擋在記帳層，避免任何呼叫端漏判
  const holderRole = role || (await getRole(userId));
  if (!COIN_HOLDER_ROLES.includes(holderRole)) {
    throw new Error(`角色 ${holderRole} 沒有幣系統，不可記幣`);
  }

  const batch = db.batch();
  batch.set(db.collection(COL.users).doc(userId), { [FIELD]: inc(total) }, { merge: true });
  for (const source of SOURCES) {
    if (want[source] > 0) {
      batch.set(db.collection(COL.coinTx).doc(), txEntry({
        ownerId: userId, amount: want[source], source, reason, refType, refId, date,
      }));
    }
  }
  await batch.commit();
  return { ...want, total };
}

/**
 * 個人消耗（抽獎）。以 transaction 讀餘額再扣，避免併發超扣。
 */
async function spendUser({ userId, amount, reason, refType, refId, date }) {
  const amt = Math.abs(Number(amount) || 0);
  if (amt <= 0) throw new Error('消耗金額需為正數');

  const userRef = db.collection(COL.users).doc(userId);

  const balanceAfter = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('使用者不存在');
    const data = snap.data();

    if (!COIN_HOLDER_ROLES.includes(data.role)) {
      const err = new Error('此身份沒有兌換與抽獎功能');
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
      ownerId: userId, amount: -amt, source: null, reason, refType, refId, date,
    }));
    return current - amt;
  });

  return { spent: amt, balanceAfter };
}

/**
 * 沖銷先前的發幣（例如教師誤點「吃完」後取消勾選）。
 * 以 transaction 讀餘額再扣，並在 0 處夾住——學生可能已經把幣花掉，
 * 不可讓餘額變成負數；實際沖銷多少會寫在總帳裡，帳目仍可追。
 * 夾住時依 E→S→G 的順序分攤到各來源。
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
    const take = Math.min(current, total);
    let budget = take;

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
            ownerId: userId, amount: -applied[source], source, reason, refType, refId, date,
          }));
        }
      }
    }
    return { ...applied, total: take };
  });
}

module.exports = {
  FIELD,
  SOURCES,
  awardUser,
  spendUser,
  reverseAward,
};
