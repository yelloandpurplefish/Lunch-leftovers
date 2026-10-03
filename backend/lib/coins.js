/**
 * 幣別記帳：**所有** E/S 幣的增減都要走這裡，不要在 controller 直接 increment。
 *
 * 規則（config/schema.js 為準）：
 *  - 家長沒有幣系統：任何試圖給家長記幣的呼叫都會被擋下。
 *  - 午餐長只累積不消耗：`spendUser` 只允許 COIN_SPENDER_ROLES。
 *  - 班級增長「全額」加給班上每位學生（CLASS_COIN_TO_MEMBER = 'full'），
 *    班級池自己也記一份，供班際排行與展示。
 *  - 每一筆增減都寫進 coin_transactions 總帳，餘額才有稽核依據
 *    （原本的系統只有餘額欄位，出錯無從追查）。
 */
const { db, admin } = require('../config/firebase');
const { COL, ROLES, COIN_HOLDER_ROLES, COIN_SPENDER_ROLES } = require('../config/schema');
const { today } = require('./dates');

const inc = (n) => admin.firestore.FieldValue.increment(n);
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

/** 對應幣別到 users 文件的欄位名（沿用原有欄位，避免動到他的 UI）。*/
const FIELD = { E: 'eCoin', S: 'sCoin' };

function txEntry({ ownerType, ownerId, coin, amount, reason, refType, refId, date, trees }) {
  return {
    ownerType,           // 'user' | 'class'
    ownerId,
    coin,                // 'E' | 'S'
    amount,              // 正=獲得、負=消耗
    reason,
    refType: refType || null,
    refId: refId || null,
    date: date || today(),
    /**
     * 這筆 S 幣對應幾棵樹。
     *
     * 存在總帳而不是只靠使用者身上的累計欄位，是因為英雄榜要能問
     * 「**這學期**種了幾棵樹」；而且樹→幣的放大常數(sCoinPerTree)可在面板調整，
     * 事後用幣數回推樹數會算錯歷史。
     */
    trees: Number(trees || 0),
    createdAt: serverTime(),
  };
}

/**
 * 個人加幣。E/S 皆為 0 時直接回傳，不留空帳。
 * @returns {Promise<{E:number,S:number}>} 實際發出的量
 */
async function awardUser({ userId, E = 0, S = 0, reason, refType, refId, date, role }) {
  if (!userId) throw new Error('awardUser 缺少 userId');
  if (E <= 0 && S <= 0) return { E: 0, S: 0 };

  // 家長不持幣：擋在記帳層，避免任何呼叫端漏判
  const holderRole = role || (await getRole(userId));
  if (!COIN_HOLDER_ROLES.includes(holderRole)) {
    throw new Error(`角色 ${holderRole} 沒有幣系統，不可記幣`);
  }

  const batch = db.batch();
  const userRef = db.collection(COL.users).doc(userId);
  const updates = {};
  if (E > 0) updates[FIELD.E] = inc(E);
  if (S > 0) updates[FIELD.S] = inc(S);
  batch.set(userRef, updates, { merge: true });

  for (const [coin, amount] of [['E', E], ['S', S]]) {
    if (amount > 0) {
      batch.set(
        db.collection(COL.coinTx).doc(),
        txEntry({ ownerType: 'user', ownerId: userId, coin, amount, reason, refType, refId, date })
      );
    }
  }
  await batch.commit();
  return { E: Math.max(0, E), S: Math.max(0, S) };
}

/**
 * 班級加幣：班級池 + **全額**加給班上每位持幣成員（學生與午餐長）。
 * @returns {Promise<{members:number, perMember:{E:number,S:number}}>}
 */
/**
 * @param {number} treesPerCapita 每位學生記到自己名下的樹（個人貢獻）
 * @param {number} treesClass     班級池記錄的樹（= 人均 × 供餐份數，真實環境效益）
 *
 * 兩個樹數刻意用不同基數：班級數字要反映真實的環境效益（以供餐份數計），
 * 個人數字是「我這一份的貢獻」。班上已註冊人數可能少於供餐份數，
 * 所以兩者加總不會相等——這是不同的統計口徑，不是帳不平。
 */
async function awardClassAndMembers({
  classId, E = 0, S = 0, treesPerCapita = 0, treesClass = 0,
  reason, refType, refId, date,
}) {
  if (!classId) throw new Error('awardClassAndMembers 缺少 classId');
  if (E <= 0 && S <= 0 && treesPerCapita <= 0 && treesClass <= 0) {
    return { members: 0, perMember: { E: 0, S: 0, trees: 0 } };
  }

  const membersSnap = await db.collection(COL.users)
    .where('classId', '==', classId)
    .where('role', 'in', COIN_HOLDER_ROLES)
    .get();

  const d = date || today();
  const batch = db.batch();

  // 班級池
  const classRef = db.collection(COL.classes).doc(classId);
  const classUpdates = {};
  if (E > 0) classUpdates[FIELD.E] = inc(E);
  if (S > 0) classUpdates[FIELD.S] = inc(S);
  if (treesClass > 0) classUpdates.treesPlanted = inc(treesClass);
  batch.set(classRef, classUpdates, { merge: true });
  // S 的分錄即使幣數進位成 0 也要留：樹數本身是要展示的成果，
  // 若因為當餐只省下 0.4 枚幣就整筆不記，累積樹數會一直漏掉小數。
  for (const [coin, amount, trees] of [['E', E, 0], ['S', S, treesClass]]) {
    if (amount > 0 || trees > 0) {
      batch.set(
        db.collection(COL.coinTx).doc(),
        txEntry({ ownerType: 'class', ownerId: classId, coin, amount, reason, refType, refId, date: d, trees })
      );
    }
  }

  // 每位成員（全額）
  membersSnap.docs.forEach((doc) => {
    const updates = {};
    if (E > 0) updates[FIELD.E] = inc(E);
    if (S > 0) updates[FIELD.S] = inc(S);
    if (treesPerCapita > 0) updates.treesPlanted = inc(treesPerCapita);
    batch.set(doc.ref, updates, { merge: true });
    for (const [coin, amount, trees] of [['E', E, 0], ['S', S, treesPerCapita]]) {
      if (amount > 0 || trees > 0) {
        batch.set(
          db.collection(COL.coinTx).doc(),
          txEntry({
            ownerType: 'user', ownerId: doc.id, coin, amount, trees,
            reason: `${reason}（班級共享）`, refType, refId, date: d,
          })
        );
      }
    }
  });

  await batch.commit();
  return {
    members: membersSnap.size,
    perMember: { E, S, trees: treesPerCapita },
    classTrees: treesClass,
  };
}

/**
 * 個人消耗（兌換/抽獎）。以 transaction 讀餘額再扣，避免併發超扣。
 * 午餐長與家長會被擋下。
 */
async function spendUser({ userId, coin, amount, reason, refType, refId, date }) {
  if (!FIELD[coin]) throw new Error(`未知幣別 ${coin}`);
  const amt = Math.abs(Number(amount) || 0);
  if (amt <= 0) throw new Error('消耗金額需為正數');

  const userRef = db.collection(COL.users).doc(userId);
  const field = FIELD[coin];

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

    const current = Number(data[field] || 0);
    if (current < amt) {
      const err = new Error(`${coin}幣不足（需 ${amt}，餘 ${current}）`);
      err.status = 409;
      throw err;
    }

    tx.update(userRef, { [field]: current - amt });
    tx.set(
      db.collection(COL.coinTx).doc(),
      txEntry({ ownerType: 'user', ownerId: userId, coin, amount: -amt, reason, refType, refId, date })
    );
    return current - amt;
  });

  return { coin, spent: amt, balanceAfter };
}

/**
 * 沖銷先前的發幣（例如教師誤點「吃完」後取消勾選）。
 * 以 transaction 讀餘額再扣，並在 0 處夾住 —— 學生可能已經把幣花掉，
 * 不可讓餘額變成負數；實際沖銷多少會寫在總帳裡，帳目仍可追。
 */
async function reverseAward({ userId, E = 0, S = 0, reason, refType, refId, date }) {
  if (E <= 0 && S <= 0) return { E: 0, S: 0 };
  const userRef = db.collection(COL.users).doc(userId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { E: 0, S: 0 };
    const data = snap.data();

    const applied = {};
    for (const [coin, want] of [['E', E], ['S', S]]) {
      if (want <= 0) continue;
      const field = FIELD[coin];
      const current = Number(data[field] || 0);
      const take = Math.min(current, want);
      applied[coin] = take;
      if (take > 0) {
        tx.update(userRef, { [field]: current - take });
        tx.set(
          db.collection(COL.coinTx).doc(),
          txEntry({ ownerType: 'user', ownerId: userId, coin, amount: -take, reason, refType, refId, date })
        );
      }
    }
    return { E: applied.E || 0, S: applied.S || 0 };
  });
}

async function getRole(userId) {
  const snap = await db.collection(COL.users).doc(userId).get();
  return snap.exists ? snap.data().role : null;
}

/** 個人餘額 + 本週獲得 + 最近異動（供「我的」頁）。*/
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
      coin: t.coin,
      amount: t.amount,
      reason: t.reason,
      date: t.date,
      createdAt: t.createdAt ? t.createdAt.toDate().toISOString() : null,
    };
  });

  return {
    balance: { E: Number(u.eCoin || 0), S: Number(u.sCoin || 0) },
    recent,
  };
}

module.exports = {
  FIELD,
  awardUser,
  awardClassAndMembers,
  spendUser,
  reverseAward,
  userCoinSummary,
};
