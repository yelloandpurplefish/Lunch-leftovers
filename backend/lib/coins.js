/**
 * ESG 幣記帳：所有 ESG 的增減都走這裡，不要在 controller 直接 increment。
 *
 * ## 一致性的規則
 *
 *  - **餘額與總帳一起寫**：每一筆增減都在同一個 batch / transaction 裡
 *    同時改 users.esgCoin 與新增一筆 coin_transactions。兩者不會一個成功一個失敗，
 *    所以「總帳加總 = 餘額」永遠成立（管理員面板的資料檢查會核對這件事）。
 *  - 只有學生持幣（COIN_HOLDER_ROLES）。家長、老師沒有幣系統，記帳層一律擋下。
 *  - 每一筆記 source（哪一種活動給的，見 config/schema.js 的 COIN_SOURCES），
 *    消耗類的 source 是 null。
 */
const { db, admin } = require('../config/firebase');
const { COL, COIN_HOLDER_ROLES, COIN_SOURCES, ESG } = require('../config/schema');
const { today } = require('./dates');

const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

/** 餘額欄位。 */
const FIELD = 'esgCoin';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** 一筆總帳分錄。amount 正=獲得、負=消耗或沖銷。 */
function ledgerEntry({ ownerId, amount, source = null, reason, refType, refId, date, by }) {
  if (source && !COIN_SOURCES[source]) throw new Error(`未知的幣來源 ${source}`);
  return {
    ownerType: 'user',
    ownerId,
    coin: ESG,
    source,
    amount,
    reason: reason || '',
    refType: refType || null,
    refId: refId || null,
    date: date || today(),
    by: by || null,             // 管理員操作時記下是誰
    createdAt: serverTime(),
  };
}

/**
 * 在一個已經開好的 transaction 裡，把某人的餘額改變 delta，並寫一筆總帳。
 * 呼叫端必須先在同一個 transaction 裡讀過使用者（傳入 user 資料），
 * Firestore 的 transaction 要求所有讀取在寫入之前。
 *
 * @param {{clampAtZero?: boolean}} opts
 *   clampAtZero：扣的比餘額多時夾在 0（沖銷用：學生可能已經把幣花掉了，不追成負數）；
 *   不夾的話直接拒絕（消耗用：餘額不足就不能買）。
 * @returns {number} 實際變動量（夾住時可能比要求的少）
 */
function applyInTx(tx, { userRef, user, delta, clampAtZero = false, ...entry }) {
  if (!COIN_HOLDER_ROLES.includes(user.role)) throw fail(400, '此身份沒有幣系統');
  const balance = Number(user[FIELD] || 0);
  let d = Number(delta) || 0;
  if (d < 0 && balance + d < 0) {
    if (!clampAtZero) throw fail(409, `ESG 幣不足（需 ${-d}，餘 ${balance}）`);
    d = -balance;
  }
  if (d === 0) return 0;
  tx.update(userRef, { [FIELD]: balance + d });
  tx.set(db.collection(COL.coinTx).doc(), ledgerEntry({ ownerId: userRef.id, amount: d, ...entry }));
  return d;
}

/** 個人加幣（家長簽到）。 */
async function awardUser({ userId, amount, source, reason, refType, refId, date, role }) {
  if (!userId) throw new Error('awardUser 缺少 userId');
  const n = Number(amount) || 0;
  if (n <= 0) return 0;
  const holderRole = role || (await db.collection(COL.users).doc(userId).get()).get('role');
  if (!COIN_HOLDER_ROLES.includes(holderRole)) {
    throw new Error(`角色 ${holderRole} 沒有幣系統，不可記幣`);
  }
  const batch = db.batch();
  batch.update(db.collection(COL.users).doc(userId), { [FIELD]: admin.firestore.FieldValue.increment(n) });
  batch.set(db.collection(COL.coinTx).doc(), ledgerEntry({
    ownerId: userId, amount: n, source, reason, refType, refId, date,
  }));
  await batch.commit();
  return n;
}

/**
 * 個人消耗（抽獎）。
 * @param {(tx)=>void} [extra] 要跟扣幣一起成功或一起失敗的其他寫入（例如抽獎紀錄）
 */
async function spendUser({ userId, amount, reason, refType, refId, date, extra }) {
  const amt = Math.abs(Number(amount) || 0);
  if (amt <= 0) throw new Error('消耗金額需為正數');
  const userRef = db.collection(COL.users).doc(userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw fail(404, '使用者不存在');
    const user = snap.data();
    if (!COIN_HOLDER_ROLES.includes(user.role)) throw fail(403, '此身份沒有兌換與抽獎功能');
    applyInTx(tx, { userRef, user, delta: -amt, reason, refType, refId, date });
    if (extra) extra(tx);
    return { spent: amt, balanceAfter: Number(user[FIELD] || 0) - amt };
  });
}

/** 管理員手動調整（可正可負；扣到負數會被拒絕）。 */
async function adjustUser({ userId, amount, reason, by }) {
  const n = Math.trunc(Number(amount));
  if (!Number.isFinite(n) || n === 0) throw fail(400, '調整量需為非 0 的整數');
  if (!String(reason || '').trim()) throw fail(400, '請寫下調整原因（會記在總帳上）');
  const userRef = db.collection(COL.users).doc(userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw fail(404, '查無此使用者');
    const user = snap.data();
    const applied = applyInTx(tx, {
      userRef, user, delta: n, source: 'admin', reason: String(reason).trim(), refType: 'admin_adjust', by,
    });
    return { applied, balanceAfter: Number(user[FIELD] || 0) + applied };
  });
}

module.exports = {
  FIELD,
  ledgerEntry,
  applyInTx,
  awardUser,
  spendUser,
  adjustUser,
};
