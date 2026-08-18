const bcrypt = require('bcryptjs');
const { admin, db } = require('./firebase');

// ============================================================
// 基礎資料（master data）
// 註：Firestore 為 schemaless，集合會在首次寫入時自動建立，
//     因此「建立資料表」實際上是寫入初始資料。
// ============================================================

const REWARD_ITEMS = [
  {
    itemId: 'eco_cup',
    name: '環保杯',
    description: '可重複使用的環保杯，減少一次性餐具浪費',
    costType: 'E',
    cost: 50,
    category: 'exchange',
    stock: null,
    isActive: true
  },
  {
    itemId: 'eco_utensils',
    name: '環保餐具',
    description: '不鏽鋼環保餐具組，包含湯匙、叉子、筷子',
    costType: 'E',
    cost: 80,
    category: 'exchange',
    stock: null,
    isActive: true
  },
  {
    itemId: 'stationery_set',
    name: '文具禮包',
    description: '實用文具組合，包含筆記本與鉛筆',
    costType: 'S',
    cost: 30,
    category: 'exchange',
    stock: null,
    isActive: true
  },
  {
    itemId: 'eco_bag',
    name: '環保購物袋',
    description: '耐用環保購物袋，減少塑膠袋使用',
    costType: 'G',
    cost: 20,
    category: 'exchange',
    stock: null,
    isActive: true
  }
];

const SYSTEM_CONFIG = [
  { key: 'lottery_cost', value: 10, description: '每次抽獎消耗的 E幣' },
  { key: 'task_cooldown_hours', value: 24, description: '任務冷卻時間（小時）' },
  {
    key: 'light_disc_rewards',
    value: { eCoin: 10, sCoin: 5, score: 30 },
    description: '光盤行動完成獎勵'
  },
  {
    key: 'leftover_reward_tiers',
    value: [
      { maxGrams: 10, eCoin: 20, sCoin: 10 },
      { maxGrams: 30, eCoin: 15, sCoin: 8 },
      { maxGrams: 50, eCoin: 10, sCoin: 5 },
      { maxGrams: null, eCoin: 5, sCoin: 2 }
    ],
    description: '剩食獎勵級距（依剩食克數）'
  }
];

const DEFAULT_MENU_ITEMS = [
  { name: '香酥雞腿', category: 'main' },
  { name: '高麗菜', category: 'side' },
  { name: '蒸蛋', category: 'side' },
  { name: '蘋果', category: 'fruit' },
  { name: '玉米濃湯', category: 'soup' }
];

// ============================================================
// 測試帳號定義
// 密碼一律由 TEST_USER_PASSWORD 環境變數提供，不在程式中硬編碼
// ============================================================

const TEST_ACCOUNTS = [
  { email: 'dev@lunch-leftovers.local', displayName: '開發人員', role: 'admin', eCoin: 1000, sCoin: 500, gCoin: 200, score: 10000, classId: 'class-3a' },
  { email: 'qa@lunch-leftovers.local', displayName: '測試人員', role: 'admin', eCoin: 1000, sCoin: 500, gCoin: 200, score: 10000, classId: 'class-3a' },
  { email: 'teacher@lunch-leftovers.local', displayName: '測試老師', role: 'teacher', eCoin: 500, sCoin: 300, gCoin: 100, score: 5000, classId: 'class-3a' },
  { email: 'student@lunch-leftovers.local', displayName: '測試學生', role: 'student', eCoin: 100, sCoin: 50, gCoin: 30, score: 1000, classId: 'class-3a' }
];

// ============================================================
// 基礎資料寫入（idempotent，可重複執行）
// ============================================================

async function seedRewardItems() {
  const batch = db.batch();

  REWARD_ITEMS.forEach(({ itemId, ...data }) => {
    const ref = db.collection('reward_items').doc(itemId);
    // merge: true → 已存在時只補上缺少的欄位，不覆寫管理員的手動調整
    batch.set(ref, data, { merge: true });
  });

  await batch.commit();
  console.log(`  ✓ reward_items：${REWARD_ITEMS.length} 筆`);
}

async function seedSystemConfig() {
  const batch = db.batch();

  SYSTEM_CONFIG.forEach(({ key, value, description }) => {
    const ref = db.collection('system_config').doc(key);
    batch.set(ref, {
      key,
      value,
      description,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  await batch.commit();
  console.log(`  ✓ system_config：${SYSTEM_CONFIG.length} 筆`);
}

async function seedTodayMenu() {
  // 日期作為文件 ID，同一天重複執行不會產生重複資料
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection('daily_menu').doc(today);

  const existing = await ref.get();
  if (existing.exists) {
    console.log(`  ✓ daily_menu：${today} 已存在，跳過`);
    return;
  }

  await ref.set({
    date: today,
    items: DEFAULT_MENU_ITEMS,
    isActive: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`  ✓ daily_menu：已建立 ${today}`);
}

// ============================================================
// 測試帳號建立
// ============================================================

async function seedTestAccounts(password) {
  const results = { created: [], existing: [], failed: [] };
  const passwordHash = await bcrypt.hash(password, 10);
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const account of TEST_ACCOUNTS) {
    try {
      const snapshot = await db.collection('users').where('email', '==', account.email).limit(1).get();

      if (!snapshot.empty) {
        results.existing.push(account.email);
      } else {
        const userId = db.collection('users').doc().id;

        await db.collection('users').doc(userId).set({
          userId,
          email: account.email,
          displayName: account.displayName,
          passwordHash,
          eCoin: account.eCoin,
          sCoin: account.sCoin,
          gCoin: account.gCoin || 0,
          score: account.score,
          classId: account.classId || null,
          role: account.role,
          isActive: true,
          isTestAccount: true,
          createdAt: now,
          lastLoginAt: now
        });

        results.created.push(account.email);
      }
    } catch (error) {
      console.error(`  ✗ ${account.email}：${error.message}`);
      results.failed.push({ email: account.email, error: error.message });
    }
  }

  if (results.created.length) console.log(`  ✓ 已建立：${results.created.join(', ')}`);
  if (results.existing.length) console.log(`  ✓ 已存在：${results.existing.join(', ')}`);

  // 輸出測試帳號登入資訊，方便開發測試
  console.log('  📋 測試帳號登入資訊：');
  console.log('  ' + '='.repeat(60));
  console.log(`  ${'角色'.padEnd(8)} | ${'顯示名稱'.padEnd(8)} | Email`);
  console.log('  ' + '-'.repeat(60));
  TEST_ACCOUNTS.forEach(({ email, displayName, role }) => {
    console.log(`  ${role.padEnd(8)} | ${displayName.padEnd(8)} | ${email}`);
  });
  console.log('  ' + '='.repeat(60));
  console.log(`  共用密碼：${password}`);
  console.log('  ⚠️  這些帳號僅供開發測試，正式上線前請刪除');

  return results;
}

// ============================================================
// 額外測試帳號（可批量產生）
// ============================================================

async function seedExtraTestAccounts(count, password) {
  const results = { created: 0, existing: 0, failed: [] };
  const passwordHash = await bcrypt.hash(password, 10);
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (let i = 1; i <= count; i++) {
    const email = `test-student-${String(i).padStart(3, '0')}@lunch-leftovers.local`;
    const displayName = `測試學生${i}`;

    try {
      const snapshot = await db.collection('users').where('email', '==', email).limit(1).get();

      if (!snapshot.empty) {
        results.existing++;
      } else {
        const userId = db.collection('users').doc().id;

        await db.collection('users').doc(userId).set({
          userId,
          email,
          displayName,
          passwordHash,
          eCoin: 50,
          sCoin: 20,
          gCoin: 10,
          score: 100,
          classId: 'class-extra',
          role: 'student',
          isActive: true,
          isTestAccount: true,
          createdAt: now,
          lastLoginAt: now
        });

        results.created++;
      }
    } catch (error) {
      console.error(`  ✗ ${email}：${error.message}`);
      results.failed.push({ email, error: error.message });
    }
  }

  if (results.created) console.log(`  ✓ 額外測試學生帳號已建立：${results.created} 筆`);
  if (results.existing) console.log(`  ✓ 額外測試學生帳號已存在：${results.existing} 筆`);

  if (results.created > 0 || results.existing > 0) {
    console.log('  📋 額外測試學生帳號登入資訊：');
    console.log('  ' + '='.repeat(40));
    console.log(`  帳號範例：test-student-001@lunch-leftovers.local`);
    console.log(`  數量：${count} 個`);
    console.log(`  共用密碼：${password}`);
    console.log('  ⚠️  這些帳號僅供開發測試，正式上線前請刪除');
    console.log('  ' + '='.repeat(40));
  }

  return results;
}

// ============================================================
// 主流程
// ============================================================

async function initializeDatabase() {
  if (!db) {
    console.warn('⚠️  Firebase Admin SDK 未初始化，跳過資料初始化');
    return;
  }

  console.log('\n🌱 開始初始化資料庫...');

  try {
    await seedRewardItems();
    await seedSystemConfig();
    await seedTodayMenu();
  } catch (error) {
    console.error('❌ 基礎資料初始化失敗:', error.message);
    // 不中斷伺服器啟動，基礎資料可稍後手動補
  }

  // ---- 測試帳號：需明確開啟 ----
  if (process.env.SEED_TEST_ACCOUNTS !== 'true') {
    console.log('  ⏭️  測試帳號未啟用（設定 SEED_TEST_ACCOUNTS=true 以建立）');
    console.log('✅ 資料庫初始化完成\n');
    return;
  }

  const password = process.env.TEST_USER_PASSWORD;

  if (!password) {
    console.error('  ✗ 已設定 SEED_TEST_ACCOUNTS=true 但缺少 TEST_USER_PASSWORD，跳過建立');
    console.log('✅ 資料庫初始化完成\n');
    return;
  }

  if (password.length < 12) {
    console.error('  ✗ TEST_USER_PASSWORD 長度需至少 12 字元，跳過建立');
    console.log('✅ 資料庫初始化完成\n');
    return;
  }

  // 生產環境需額外確認，避免正式站意外存在共用測試帳號
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_TEST_ACCOUNTS !== 'true') {
    console.warn('  ⚠️  生產環境已阻擋建立測試帳號');
    console.warn('     如確實需要，請設定 ALLOW_PRODUCTION_TEST_ACCOUNTS=true');
    console.log('✅ 資料庫初始化完成\n');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn('  ⚠️  正在生產環境建立測試帳號，請於驗證完成後停用並刪除');
  }

  try {
    await seedTestAccounts(password);
  } catch (error) {
    console.error('❌ 測試帳號建立失敗:', error.message);
  }

  // 額外批次建立測試帳號
  const extraCount = parseInt(process.env.EXTRA_TEST_ACCOUNTS, 10);
  if (extraCount > 0) {
    try {
      console.log(`\n🌱 開始建立 ${extraCount} 個額外測試學生帳號...`);
      await seedExtraTestAccounts(extraCount, password);
    } catch (error) {
      console.error('❌ 額外測試帳號建立失敗:', error.message);
    }
  }

  console.log('✅ 資料庫初始化完成\n');
}

module.exports = { initializeDatabase, TEST_ACCOUNTS };
