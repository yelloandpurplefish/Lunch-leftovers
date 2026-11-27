/**
 * 刪除前的依賴檢查。
 *
 * ## 為什麼不直接刪
 *
 * 這個系統到處都是「以 classId / userId / deviceId 交叉參照」的資料：
 * 場次、各菜剩餘量、用餐檢查、幣的總帳、家長簽到、裝置讀數。
 * 直接刪掉一個班級或一個學生，那些資料不會跟著消失，只會變成
 * 指向不存在對象的孤兒——班際排行、剩餘量曲線、英雄榜都會算出錯的數字，
 * 而且**不會報錯**，只會靜靜地錯。
 *
 * 所以這一層的規則是：
 *   · 有依賴資料 → **拒絕刪除**，並把每一種依賴的筆數列出來，
 *     讓管理員知道要先處理什麼（或改用「停用」）
 *   · 沒有依賴   → 允許刪除，並順手清掉只屬於它的附屬資料
 *
 * ## 停用與刪除的分工
 *
 *   停用（isActive / status）  人還在、歷史要留 → 日常用這個
 *   刪除                       建錯了、重複、測試資料 → 只在乾淨時才給
 *
 * 一個學期跑過的帳號幾乎不可能是乾淨的，所以實際上刪除只會發生在
 * 「剛建錯」的情境——那正是需要它的時候。
 */
const { db } = require('./../config/firebase');
const { COL } = require('./../config/schema');

/** 數某個查詢有幾筆（只要筆數，用 count() 省讀取量）。 */
async function countWhere(collection, field, value) {
  try {
    const snap = await db.collection(collection).where(field, '==', value).count().get();
    return snap.data().count;
  } catch (error) {
    // count() 需要較新的 SDK；退回抓文件數（上限 500，足夠判斷「有沒有」）
    const snap = await db.collection(collection).where(field, '==', value).limit(500).get();
    return snap.size;
  }
}

/**
 * 班級的依賴。
 * 注意 meal_sessions / dish_leftovers 的 doc id 以 classId 開頭，
 * 但這裡仍用欄位查詢——doc id 前綴查詢在 Firestore 要用 range，可讀性差且易錯。
 */
async function classDependencies(classId) {
  const [users, sessions, leftovers, plates, devices] = await Promise.all([
    countWhere(COL.users, 'classId', classId),
    countWhere(COL.mealSessions, 'classId', classId),
    countWhere(COL.dishLeftovers, 'classId', classId),
    countWhere(COL.plateScans, 'classId', classId),
    countWhere(COL.devices, 'classId', classId),
  ]);
  return [
    { label: '名下的使用者（學生／導師）', count: users, hint: '請先改到其他班或刪除' },
    { label: '量測場次', count: sessions, hint: '歷史紀錄，刪班會讓統計失去依據' },
    { label: '各菜剩餘量紀錄', count: leftovers, hint: '班際支援與剩餘量曲線的資料來源' },
    { label: '餐盤紀錄', count: plates, hint: '學生拍餐盤的歷史' },
    { label: '綁定的稱重模組', count: devices, hint: '請先解除綁定或刪除裝置' },
  ].filter((d) => d.count > 0);
}

/** 使用者的依賴。幣的總帳是稽核資料，有紀錄就不該讓它無聲消失。 */
async function userDependencies(userId) {
  const [coinTx, plates, tasks, exchanges, signIns, boundParents] = await Promise.all([
    countWhere(COL.coinTx, 'ownerId', userId),
    countWhere(COL.plateScans, 'userId', userId),
    countWhere(COL.taskRecords, 'userId', userId),
    countWhere(COL.exchangeRecords, 'userId', userId),
    countWhere(COL.parentSignIns, 'studentId', userId),
    countWhere(COL.users, 'boundStudentId', userId),
  ]);
  return [
    { label: '幣的總帳分錄', count: coinTx, hint: '稽核資料，建議改用「停用」保留歷史' },
    { label: '餐盤辨識紀錄', count: plates, hint: '' },
    { label: '任務／問卷紀錄', count: tasks, hint: '' },
    { label: '兌換紀錄', count: exchanges, hint: '' },
    { label: '家長簽到紀錄', count: signIns, hint: '' },
    { label: '綁定這位學生的家長帳號', count: boundParents, hint: '請先解除綁定' },
  ].filter((d) => d.count > 0);
}

/** 裝置的依賴：只有讀數，而讀數本身帶 classId + date，拿掉裝置仍有意義。 */
async function deviceDependencies(deviceId) {
  const readings = await countWhere(COL.deviceReadings, 'deviceId', deviceId);
  return { readings };
}

/** 把依賴整理成一句能直接顯示給人的話。 */
function describe(deps) {
  return deps.map((d) => `${d.label} ${d.count} 筆${d.hint ? `（${d.hint}）` : ''}`).join('；');
}

/**
 * 分批刪除一個查詢的全部結果。
 * Firestore 單次 batch 上限 500，所以要切塊；而且刪除期間不該一次讀進全部文件。
 */
async function deleteByQuery(collection, field, value, { chunk = 300 } = {}) {
  let removed = 0;
  for (;;) {
    const snap = await db.collection(collection).where(field, '==', value).limit(chunk).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    if (snap.size < chunk) break;
  }
  return removed;
}

module.exports = {
  countWhere,
  classDependencies,
  userDependencies,
  deviceDependencies,
  describe,
  deleteByQuery,
};
