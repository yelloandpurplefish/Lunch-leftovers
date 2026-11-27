/**
 * 名冊與紀錄管線所需的基礎資料（本檔為新增，與原本的 seed.js 並存）。
 *
 *  · classes：班級名冊。**沒有名冊就無法註冊學生**（年級/班級要對得上），
 *    也無法換算供餐份數，所以列為基礎資料，每次啟動都確保存在。
 *  · dishes：菜色資料庫（每份份量/單價/碳排係數），稱重靠它算供應量、成本與碳排。
 *  · daily_menu 的 slot 對應：6 個欄位 → dishId，稱重清單照這個順序列出菜色。
 *
 * 全部 idempotent：以固定 doc id 寫入，重複執行不會產生重複資料。
 */
const bcrypt = require('bcryptjs');
const { admin, db } = require('./firebase');
const { COL, ROLES, ALL_ROLES, COIN_HOLDER_ROLES, MENU_SLOTS } = require('./schema');
const { today } = require('../lib/dates');
const menuSheet = require('../lib/menuSheet');
const { bindParent } = require('../lib/roster');

const SCHOOL_ID = 'school-demo';
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

const CLASSES = [
  { classId: 'cls-301', grade: '3', name: '301', headcount: 28 },
  { classId: 'cls-302', grade: '3', name: '302', headcount: 30 },
  { classId: 'cls-305', grade: '3', name: '305', headcount: 26 },
];

/** unitCost 元/kg、emissionFactor kgCO2e/kg、portionG 每人份量。 */
const DISHES = [
  { dishId: 'dish-rice-brown', name: '糙米飯', category: '主食', portionG: 120, unitCost: 60, emissionFactor: 1.2 },
  { dishId: 'dish-rice-white', name: '白米飯', category: '主食', portionG: 120, unitCost: 55, emissionFactor: 1.2 },
  { dishId: 'dish-chicken-leg', name: '紅燒雞腿', category: '主菜', portionG: 90, unitCost: 180, emissionFactor: 6.1 },
  { dishId: 'dish-pork-cabbage', name: '香菇炒肉', category: '主菜', portionG: 85, unitCost: 160, emissionFactor: 7.2 },
  { dishId: 'dish-tofu', name: '滷豆腐', category: '副菜', portionG: 70, unitCost: 70, emissionFactor: 2.0 },
  { dishId: 'dish-egg', name: '滷蛋', category: '副菜', portionG: 60, unitCost: 95, emissionFactor: 4.7 },
  { dishId: 'dish-cabbage', name: '炒高麗菜', category: '蔬菜', portionG: 80, unitCost: 45, emissionFactor: 0.5 },
  { dishId: 'dish-bokchoy', name: '炒青江菜', category: '蔬菜', portionG: 80, unitCost: 48, emissionFactor: 0.5 },
  { dishId: 'dish-corn-soup', name: '玉米濃湯', category: '湯品', portionG: 200, unitCost: 35, emissionFactor: 0.9 },
  { dishId: 'dish-radish-soup', name: '蘿蔔湯', category: '湯品', portionG: 200, unitCost: 30, emissionFactor: 0.4 },
];

/** 今日菜單的 slot → dishId（示範用固定一組）。*/
const TODAY_SLOTS = {
  staple: 'dish-rice-brown',
  main: 'dish-chicken-leg',
  side1: 'dish-tofu',
  side2: 'dish-egg',
  veg: 'dish-cabbage',
  soup: 'dish-corn-soup',
};

async function seedClasses() {
  const batch = db.batch();
  CLASSES.forEach(({ classId, ...data }) => {
    batch.set(
      db.collection(COL.classes).doc(classId),
      { classId, schoolId: SCHOOL_ID, ...data, updatedAt: serverTime() },
      // 只覆寫名冊欄位，保留導師、午餐長等指派
      { mergeFields: ['classId', 'schoolId', 'grade', 'name', 'headcount', 'updatedAt'] }
    );
  });
  await batch.commit();
  console.log(`  ✓ classes：${CLASSES.length} 班（${CLASSES.map((c) => c.name).join('、')}）`);
}

async function seedDishes() {
  const batch = db.batch();
  DISHES.forEach(({ dishId, ...data }) => {
    batch.set(db.collection(COL.dishes).doc(dishId), { dishId, ...data }, { mergeFields: Object.keys(data).concat('dishId') });
  });
  await batch.commit();
  console.log(`  ✓ dishes：${DISHES.length} 道`);
}

/**
 * 沒有真正的菜單時，給今天放一份示範菜色，讓稱重流程在開發環境走得通。
 *
 * **絕不覆寫**：原本每次啟動都以 merge 寫入，會把從試算表同步來的今日菜色逐欄蓋掉，
 * 不供餐日也會被改成供餐。現在：
 *  · 設定了菜單試算表（MENU_SHEET_URL＋TOKEN）→ 菜單以試算表為準，完全不放示範
 *  · 今天已有任何菜色，或已標記不供餐 → 不動
 *  · 只有今天完全沒有菜色時才補上示範的一組
 */
async function seedTodayMenuSlots() {
  const date = today();
  if (menuSheet.configured()) {
    console.log(`  ⏭️  daily_menu ${date}：已設定菜單試算表，不放示範菜色`);
    return;
  }
  const ref = db.collection(COL.dailyMenu).doc(date);
  const snap = await ref.get();
  const menu = snap.exists ? snap.data() : null;
  if (menu && menu.isActive === false) {
    console.log(`  ⏭️  daily_menu ${date}：今天標記不供餐，不放示範菜色`);
    return;
  }
  const hasDishes = Boolean(menu && menu.dishes && MENU_SLOTS.some((s) => menu.dishes[s]));
  if (hasDishes) {
    console.log(`  ✓ daily_menu ${date}：已有菜色，不覆寫`);
    return;
  }
  await ref.set(
    { menuId: date, date, dishes: TODAY_SLOTS, isActive: true, updatedAt: serverTime() },
    { merge: true }
  );
  console.log(`  ✓ daily_menu ${date}：今天沒有菜色，放入示範的 ${MENU_SLOTS.length} 道`);
}

// ── 示範帳號（含名冊欄位），需 SEED_TEST_ACCOUNTS=true ──────────────
const DEMO_USERS = [
  {
    account: 'teacher302', displayName: '三年二班・導師', role: ROLES.TEACHER,
    classId: 'cls-302', grade: '3', className: '302',
  },
  {
    // 午餐長就是一位學生，另外被指定為 302 班的午餐長（classes.lunchLeaderUserId）
    account: 'leader302', displayName: '302・午餐長', role: ROLES.STUDENT,
    classId: 'cls-302', grade: '3', className: '302', seatNo: '01',
    lunchLeaderOf: 'cls-302',
  },
  {
    account: 'stu302-02', displayName: '302・王小明', role: ROLES.STUDENT,
    classId: 'cls-302', grade: '3', className: '302', seatNo: '02',
  },
  {
    account: 'stu302-03', displayName: '302・陳美惠', role: ROLES.STUDENT,
    classId: 'cls-302', grade: '3', className: '302', seatNo: '03',
  },
  {
    account: 'stu301-01', displayName: '301・林大同', role: ROLES.STUDENT,
    classId: 'cls-301', grade: '3', className: '301', seatNo: '01',
  },
  {
    // 技術員：只管稱重模組的佈建與維護，碰不到學生資料與幣
    account: 'tech01', displayName: '設備技術員', role: ROLES.TECHNICIAN,
  },
];

/** 綁定到 stu302-02 的家長（示範家長簽到）。*/
const DEMO_PARENT = {
  account: 'parent302@example.com', displayName: '王小明的家長', role: ROLES.PARENT,
  studentAccount: 'stu302-02',
};

async function findByAccount(account) {
  const idx = await db.collection(COL.accountIndex).doc(account.toLowerCase()).get();
  if (!idx.exists) return null;
  const snap = await db.collection(COL.users).doc(idx.data().userId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function upsertUser(spec, passwordHash) {
  const existing = await findByAccount(spec.account);
  if (existing) {
    // 示範帳號的角色若已不是有效角色（例如改版前的 lunch_leader），改回規格裡的角色；
    // 有效角色一律不動，管理員手動改過的不會被啟動蓋回去
    if (!ALL_ROLES.includes(existing.role)) {
      await db.collection(COL.users).doc(existing.id).set({
        role: spec.role,
        ...(COIN_HOLDER_ROLES.includes(spec.role) && existing.esgCoin === undefined ? { esgCoin: 0 } : {}),
      }, { merge: true });
      console.log(`  ✓ ${spec.account}：角色 ${existing.role} 已不存在，改為 ${spec.role}`);
    }
    return { id: existing.id, created: false };
  }

  const userId = db.collection(COL.users).doc().id;
  const isCoinHolder = COIN_HOLDER_ROLES.includes(spec.role);
  const data = {
    userId,
    account: spec.account,
    email: spec.account.includes('@') ? spec.account : null,
    displayName: spec.displayName,
    passwordHash,
    role: spec.role,
    isActive: true,
    isTestAccount: true,
    schoolId: SCHOOL_ID,
    classId: spec.classId || null,
    grade: spec.grade || null,
    className: spec.className || null,
    seatNo: spec.seatNo || null,
    createdAt: serverTime(),
    lastLoginAt: serverTime(),
    ...(isCoinHolder ? { esgCoin: 0 } : {}),
  };

  const batch = db.batch();
  batch.set(db.collection(COL.users).doc(userId), data);
  batch.set(db.collection(COL.accountIndex).doc(spec.account.toLowerCase()), {
    userId, role: spec.role, createdAt: serverTime(),
  });
  await batch.commit();
  return { id: userId, created: true };
}

/**
 * 建立示範名冊帳號（教師 / 學生 / 家長 / 技術員）。
 * 導師寫回 classes.teacherUserId；被指定為午餐長的學生寫回 lunchLeaderUserId。
 */
async function seedDemoRoster(password) {
  const passwordHash = await bcrypt.hash(password, 10);
  const created = [];

  for (const spec of DEMO_USERS) {
    const { id, created: isNew } = await upsertUser(spec, passwordHash);
    if (isNew) created.push(`${spec.account}(${spec.role})`);

    if (spec.role === ROLES.TEACHER && spec.classId) {
      await db.collection(COL.classes).doc(spec.classId).set({ teacherUserId: id }, { merge: true });
    }
    if (spec.lunchLeaderOf) {
      await db.collection(COL.classes).doc(spec.lunchLeaderOf).set({ lunchLeaderUserId: id }, { merge: true });
    }
  }

  // 家長：綁定示範學生（兩邊一起寫，見 lib/roster.js 的 bindParent）
  const student = await findByAccount(DEMO_PARENT.studentAccount);
  if (student) {
    const { id: parentId, created: isNew } = await upsertUser(DEMO_PARENT, passwordHash);
    if (isNew) created.push(`${DEMO_PARENT.account}(parent)`);
    const parent = (await db.collection(COL.users).doc(parentId).get()).data();
    // 已經綁好了就不動：管理員可能改過綁定，啟動時不該蓋回去
    if (!parent.boundStudentId && (!student.parentUserId || student.parentUserId === parentId)) {
      await bindParent(parentId, student.id, null);
    }
  }

  if (created.length) console.log(`  ✓ 示範名冊已建立：${created.join('、')}`);
  else console.log('  ✓ 示範名冊已存在');

  console.log('  📋 名冊示範帳號（密碼同 TEST_USER_PASSWORD）：');
  [...DEMO_USERS.map((u) => `${u.role.padEnd(12)} ${u.account}${u.lunchLeaderOf ? '（午餐長）' : ''}`),
   `${'parent'.padEnd(12)} ${DEMO_PARENT.account}`].forEach((line) => console.log(`     ${line}`));
}

module.exports = {
  SCHOOL_ID,
  CLASSES,
  DISHES,
  TODAY_SLOTS,
  seedClasses,
  seedDishes,
  seedTodayMenuSlots,
  seedDemoRoster,
};
