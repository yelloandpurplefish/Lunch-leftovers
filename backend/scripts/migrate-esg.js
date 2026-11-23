/**
 * E／S／G 三幣 → ESG 幣：一次性遷移。
 *
 *   node scripts/migrate-esg.js            ← 試算，只讀不寫（預設）
 *   node scripts/migrate-esg.js --apply    ← 真的寫入
 *
 * 換算係數與原因見 config/schema.js 的 ESG_CONVERSION：
 *   E × 4、S × 2、G × 0.2326 —— 「代表幾天的努力」不變。
 *   餘額與商品價格用同一組係數，購買力才不會因為合併而改變。
 *
 * ## 安全設計
 *  · 預設試算。沒有 --apply 不會寫任何東西。
 *  · 冪等：處理過的文件會留下 coinMigration 標記，重跑會跳過，不會重複換算。
 *  · 舊欄位（eCoin / sCoin / gCoin）**保留不刪**，只是新程式不再讀它們。
 *    coinMigration 記下換算前的數字與結果，要回溯或核帳都查得到。
 *  · 用「加上」而不是「設為」：新程式若先上線、已經發了一些 ESG，
 *    遷移時把舊餘額換算後加上去，那些新發的不會被蓋掉。
 *
 * ## 建議順序
 *  停掉伺服器 → --apply → 啟動新版伺服器。
 *  中間沒有空窗：舊版不會再改舊欄位，新版只讀新欄位。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { db, admin } = require('../config/firebase');
const { COL, ESG, esgFactor, ESG_CONVERSION, COIN_HOLDER_ROLES } = require('../config/schema');

const APPLY = process.argv.includes('--apply');
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();
const FACTORS = { E: esgFactor('E'), S: esgFactor('S'), G: esgFactor('G') };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toEsg = ({ E = 0, S = 0, G = 0 }) =>
  Math.round(num(E) * FACTORS.E + num(S) * FACTORS.S + num(G) * FACTORS.G);

const hasLegacy = (d) => ['eCoin', 'sCoin', 'gCoin'].some((k) => d[k] !== undefined);

/** Firestore 單次 batch 上限 500，切塊寫。 */
async function commitInChunks(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }
}

async function migrateUsers() {
  const snap = await db.collection(COL.users).get();
  const rows = [];
  const writes = [];
  let skipped = 0;
  let noLegacy = 0;

  for (const doc of snap.docs) {
    const u = doc.data();
    if (u.coinMigration) { skipped += 1; continue; }
    if (!hasLegacy(u)) { noLegacy += 1; continue; }

    const from = { E: num(u.eCoin), S: num(u.sCoin), G: num(u.gCoin) };
    const converted = toEsg(from);
    const before = num(u.esgCoin);       // 新程式若已先上線發過一些
    const after = before + converted;

    rows.push({
      name: u.displayName || u.account || u.email || doc.id,
      role: u.role, from, converted, before, after,
      holder: COIN_HOLDER_ROLES.includes(u.role),
    });
    writes.push([doc.ref, {
      esgCoin: after,
      coinMigration: {
        at: serverTime(),
        from,
        factors: FACTORS,
        converted,
        esgBefore: before,
      },
    }]);
  }

  if (APPLY && writes.length) await commitInChunks(writes);
  return { rows, skipped, noLegacy, total: snap.size };
}

async function migrateClasses() {
  const snap = await db.collection(COL.classes).get();
  const rows = [];
  const writes = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.coinMigration || !hasLegacy(c)) continue;
    const from = { E: num(c.eCoin), S: num(c.sCoin), G: num(c.gCoin) };
    const converted = toEsg(from);
    const after = num(c.esgCoin) + converted;
    rows.push({ name: `${c.grade} 年 ${c.name} 班`, from, converted, after });
    writes.push([doc.ref, {
      esgCoin: after,
      coinMigration: { at: serverTime(), from, factors: FACTORS, converted },
    }]);
  }
  if (APPLY && writes.length) await commitInChunks(writes);
  return rows;
}

async function migrateItems() {
  const snap = await db.collection(COL.rewardItems).get();
  const rows = [];
  const writes = [];
  for (const doc of snap.docs) {
    const it = doc.data();
    if (it.costType === ESG) continue;
    const factor = FACTORS[it.costType];
    if (!factor) {
      rows.push({ name: it.name, warn: `未知計價 ${it.costType}，略過` });
      continue;
    }
    const cost = Math.max(1, Math.round(num(it.cost) * factor));
    rows.push({ name: it.name, from: `${it.cost} ${it.costType}`, to: cost });
    writes.push([doc.ref, {
      costType: ESG,
      cost,
      legacyCostType: it.costType,
      legacyCost: num(it.cost),
      coinMigratedAt: serverTime(),
    }]);
  }
  if (APPLY && writes.length) await commitInChunks(writes);
  return rows;
}

/**
 * 感謝（G 來源）的額度：程式預設已由 86 改為 5，
 * 但若開發者面板曾經存過 86，資料庫裡的覆寫值會蓋過預設——那就要一起改。
 * 只有在它**剛好是舊預設 86** 時才改；管理員若設了別的值，尊重它，只提醒。
 */
async function migrateGratitude() {
  const ref = db.collection(COL.systemConfig).doc('coin_rules');
  const snap = await ref.get();
  const v = snap.exists ? (((snap.data() || {}).values || {}).gratitude || {}).mealFinishedG : undefined;
  if (v === undefined) return { status: 'default', note: '面板沒有覆寫，直接採用新預設 5' };
  if (Number(v) === 86) {
    if (APPLY) await ref.set({ values: { gratitude: { mealFinishedG: 5 } } }, { merge: true });
    return { status: 'changed', note: '面板存著舊值 86 → 改為 5' };
  }
  return { status: 'kept', note: `面板設的是 ${v}（不是舊預設 86），保留不動，請自行確認` };
}

function pad(s, n) {
  const str = String(s);
  // 中文字占兩格，粗估對齊
  const w = [...str].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(1, n - w));
}

(async () => {
  const project = (admin.app().options || {}).projectId || '(未知)';
  const where = process.env.FIRESTORE_EMULATOR_HOST
    ? `模擬器 ${process.env.FIRESTORE_EMULATOR_HOST}` : `正式專案 ${project}`;

  console.log('══════════════════════════════════════════════════════════════');
  console.log(` E／S／G → ESG 遷移　${APPLY ? '【寫入】' : '【試算，不寫入】'}`);
  console.log(` 對象：${where}`);
  console.log(` 換算：E × ${FACTORS.E}　S × ${FACTORS.S}　G × ${FACTORS.G.toFixed(4)}`
    + `（每天收入 E${ESG_CONVERSION.dailyOld.E}/S${ESG_CONVERSION.dailyOld.S}`
    + `/G${ESG_CONVERSION.dailyOld.G} → ESG ${ESG_CONVERSION.dailyNew}）`);
  console.log('══════════════════════════════════════════════════════════════');

  const users = await migrateUsers();
  console.log(`\n▍使用者　待換算 ${users.rows.length}　已遷移過 ${users.skipped}　無舊餘額 ${users.noLegacy}`);
  console.log('  ' + pad('姓名', 16) + pad('身份', 14) + 'E      S      G      →  ESG');
  users.rows
    .sort((a, b) => Number(b.holder) - Number(a.holder) || b.after - a.after)
    .forEach((r) => {
      console.log('  ' + pad(String(r.name).slice(0, 12), 16) + pad(r.role, 14)
        + String(r.from.E).padEnd(7) + String(r.from.S).padEnd(7) + String(r.from.G).padEnd(7)
        + '→ ' + String(r.after).padStart(5)
        + (r.before ? `（含先前已有 ${r.before}）` : '')
        + (r.holder ? '' : '　〔非持幣身份，僅換算保留〕'));
    });

  const classes = await migrateClasses();
  console.log(`\n▍班級池　待換算 ${classes.length}`);
  classes.forEach((r) => console.log(`  ${pad(r.name, 16)}E ${r.from.E}　S ${r.from.S} → ESG ${r.after}`));

  const items = await migrateItems();
  console.log(`\n▍商品　待換算 ${items.length}`);
  items.forEach((r) => console.log(r.warn
    ? `  ⚠️  ${r.name}：${r.warn}`
    : `  ${pad(r.name, 16)}${pad(r.from, 10)}→ ${r.to} ESG`));

  const g = await migrateGratitude();
  console.log(`\n▍感謝額度　${g.note}`);

  console.log('\n──────────────────────────────────────────────────────────────');
  if (APPLY) {
    console.log(' ✅ 已寫入。舊欄位保留未刪；每筆都留了 coinMigration 紀錄可核帳。');
  } else {
    console.log(' 這是試算，沒有寫入任何資料。確認數字無誤後加 --apply 執行。');
  }
  process.exit(0);
})().catch((e) => {
  console.error('遷移失敗：', e.code || '', e.message);
  process.exit(1);
});
