/**
 * 名冊與紀錄管線所需的基礎資料（本檔為新增，與原本的 seed.js 並存）。
 *
 *  · classes：班級名冊。**沒有名冊就無法註冊學生**（年級/班級要對得上），
 *    也無法算班級幣與班際排行，所以列為基礎資料，每次啟動都確保存在。
 *  · dishes：菜色資料庫（每份份量/單價/碳排係數），紀錄管線靠它把殘餘比例換成克數。
 *  · daily_menu 的 slot 對應：在原本的 items 之外補上 6 個欄位 → dishId，
 *    供四桶辨識把桶內菜色對回菜單（不動原有的 items，前端照舊）。
 *
 * 全部 idempotent：以固定 doc id 寫入，重複執行不會產生重複資料。
 */
const bcrypt = require('bcryptjs');
const { admin, db } = require('./firebase');
const { COL, ROLES, MENU_SLOTS } = require('./schema');
const { today } = require('../lib/dates');

const SCHOOL_ID = 'school-demo';
const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

const CLASSES = [
  { classId: 'cls-301', grade: '3', name: '301', headcount: 28 },
  { classId: 'cls-302', grade: '3', name: '302', headcount: 30 },
  { classId: 'cls-305', grade: '3', name: '305', headcount: 26 },
];

/**
 * unitCost 元/kg、emissionFactor kgCO2e/kg、portionG 每人份量。
 * proteinPerKg / fiberPerKg 為每公斤食物的營養含量（公克），E 幣公式用。
 * 沒填的菜色會退回 TUNABLE_DEFAULTS.nutrition 的分類預設值。
 */
const DISHES = [
  { dishId: 'dish-rice-brown', name: '糙米飯', category: '主食', portionG: 120, unitCost: 60, emissionFactor: 1.2, proteinPerKg: 26, fiberPerKg: 18 },
  { dishId: 'dish-rice-white', name: '白米飯', category: '主食', portionG: 120, unitCost: 55, emissionFactor: 1.2, proteinPerKg: 26, fiberPerKg: 4 },
  { dishId: 'dish-chicken-leg', name: '紅燒雞腿', category: '主菜', portionG: 90, unitCost: 180, emissionFactor: 6.1, proteinPerKg: 190, fiberPerKg: 0 },
  { dishId: 'dish-pork-cabbage', name: '香菇炒肉', category: '主菜', portionG: 85, unitCost: 160, emissionFactor: 7.2, proteinPerKg: 150, fiberPerKg: 15 },
  { dishId: 'dish-tofu', name: '滷豆腐', category: '副菜', portionG: 70, unitCost: 70, emissionFactor: 2.0, proteinPerKg: 88, fiberPerKg: 4 },
  { dishId: 'dish-egg', name: '滷蛋', category: '副菜', portionG: 60, unitCost: 95, emissionFactor: 4.7, proteinPerKg: 125, fiberPerKg: 0 },
  { dishId: 'dish-cabbage', name: '炒高麗菜', category: '蔬菜', portionG: 80, unitCost: 45, emissionFactor: 0.5, proteinPerKg: 13, fiberPerKg: 18 },
  { dishId: 'dish-bokchoy', name: '炒青江菜', category: '蔬菜', portionG: 80, unitCost: 48, emissionFactor: 0.5, proteinPerKg: 15, fiberPerKg: 22 },
  { dishId: 'dish-corn-soup', name: '玉米濃湯', category: '湯品', portionG: 200, unitCost: 35, emissionFactor: 0.9, proteinPerKg: 20, fiberPerKg: 8 },
  { dishId: 'dish-radish-soup', name: '蘿蔔湯', category: '湯品', portionG: 200, unitCost: 30, emissionFactor: 0.4, proteinPerKg: 6, fiberPerKg: 6 },
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
      // 只覆寫名冊欄位，保留班級幣池等累積值
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

/** 在今天的 daily_menu 文件補上四桶辨識需要的 slot 對應。*/
async function seedTodayMenuSlots() {
  const date = today();
  await db.collection(COL.dailyMenu).doc(date).set(
    { menuId: date, date, dishes: TODAY_SLOTS, isActive: true, updatedAt: serverTime() },
    { merge: true }
  );
  console.log(`  ✓ daily_menu ${date}：補上 ${MENU_SLOTS.length} 個欄位對應`);
}

// ── 示範帳號（含名冊欄位），需 SEED_TEST_ACCOUNTS=true ──────────────
const DEMO_USERS = [
  {
    account: 'teacher302', displayName: '三年二班・導師', role: ROLES.TEACHER,
    classId: 'cls-302', grade: '3', className: '302',
  },
  {
    account: 'leader302', displayName: '302・午餐長', role: ROLES.LUNCH_LEADER,
    classId: 'cls-302', grade: '3', className: '302', seatNo: '01',
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
  if (existing) return { id: existing.id, created: false };

  const userId = db.collection(COL.users).doc().id;
  const isCoinHolder = spec.role === ROLES.STUDENT || spec.role === ROLES.LUNCH_LEADER;
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
    ...(isCoinHolder ? { eCoin: 0, sCoin: 0, score: 0 } : {}),
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
 * 建立示範名冊帳號（教師 / 午餐長 / 學生 / 家長）。
 * 午餐長也會被寫回 classes.lunchLeaderUserId、導師寫回 teacherUserId。
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
    if (spec.role === ROLES.LUNCH_LEADER && spec.classId) {
      await db.collection(COL.classes).doc(spec.classId).set({ lunchLeaderUserId: id }, { merge: true });
    }
  }

  // 家長：綁定示範學生，並在學生身上回寫 parentUserId
  const student = await findByAccount(DEMO_PARENT.studentAccount);
  if (student) {
    const { id: parentId, created: isNew } = await upsertUser(DEMO_PARENT, passwordHash);
    if (isNew) created.push(`${DEMO_PARENT.account}(parent)`);
    await db.collection(COL.users).doc(parentId).set({
      boundStudentId: student.id,
      studentBinding: {
        grade: student.grade,
        className: student.className,
        seatNo: student.seatNo,
        account: student.account,
        studentId: student.id,
        studentName: student.displayName,
        classId: student.classId,
      },
    }, { merge: true });
    await db.collection(COL.users).doc(student.id).set(
      { parentUserId: parentId, parentName: DEMO_PARENT.displayName },
      { merge: true }
    );
  }

  if (created.length) console.log(`  ✓ 示範名冊已建立：${created.join('、')}`);
  else console.log('  ✓ 示範名冊已存在');

  console.log('  📋 名冊示範帳號（密碼同 TEST_USER_PASSWORD）：');
  [...DEMO_USERS.map((u) => `${u.role.padEnd(12)} ${u.account}`),
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
