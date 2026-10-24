/**
 * 今日菜單（唯讀）＋ 依個人體位的建議攝取熱量。
 *
 * 首頁右欄要顯示「你今天建議吃多少」，而建議值取決於體位分類，
 * 分類又取決於年齡與性別——這些都是不該送到瀏覽器再算的資料：
 *   · 判定邏輯放前端，改表格就得改前端、還會被使用者改
 *   · 年齡、性別、身高體重是個資，沒必要為了算一個數字就整包下發
 * 因此這支端點只回「結論」：體位分類、建議熱量、判定依據。
 * BMI 本人看得到（那是他自己的資料），但別人的看不到。
 */
const { db } = require('../config/firebase');
const { COL, MENU_SLOTS, SLOT_LABEL, ROLES } = require('../config/schema');
const { today, isYmd } = require('../lib/dates');
const { getSettings } = require('../lib/settings');
const { intakeAdvice } = require('../lib/bmi');
const { getDayMenu } = require('../lib/dailyMenu');

const bad = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

/**
 * GET /api/menu/today?date=YYYY-MM-DD
 *
 * 回傳當日菜單與（若查得到體位）建議攝取熱量。
 * 沒有菜單不是錯誤：段考、校外教學本來就沒有供餐，
 * 回 200 搭配 served:false，前端才能顯示「今天不供餐」而不是跳錯誤。
 */
const getTodayMenu = async (req, res) => {
  try {
    const date = isYmd(req.query.date) ? req.query.date : today();

    const menu = await getDayMenu(date);

    const intake = await adviceFor(req);

    return res.status(200).json({
      success: true,
      date,
      served: menu.served,
      note: menu.note,
      dishes: menu.dishes,
      intake,
    });
  } catch (error) {
    console.error('取得今日菜單失敗:', error);
    return bad(res, 500, error.message || '取得今日菜單失敗');
  }
};

/**
 * 建議熱量是給「要吃這一餐的人」看的。
 *  · 學生與午餐長 → 用自己的體位（req.userDoc 已經是本人的資料，不必再讀一次）
 *  · 家長         → 用綁定學生的體位（家長看的是孩子該吃多少）
 *  · 教師/管理員/技術員 → 不給個人建議，只回基準值供參考
 */
async function adviceFor(req) {
  const user = req.user;
  const settings = await getSettings();
  const intake = settings.intake || {};
  const base = {
    normalKcal: Number(intake.normalKcal) || null,
    adjustKcal: Number(intake.adjustKcal) || 0,
  };
  const none = (source) => ({ ...base, bmi: null, category: null, kcal: null, source });

  const SELF_ROLES = [ROLES.STUDENT, ROLES.LUNCH_LEADER];
  const isSelf = SELF_ROLES.includes(user.role);
  if (!isSelf && user.role !== ROLES.PARENT) return none('not_applicable');

  let target = req.userDoc;
  let forName = null;

  if (user.role === ROLES.PARENT) {
    if (!user.boundStudentId) return none('no_binding');
    const snap = await db.collection(COL.users).doc(String(user.boundStudentId)).get();
    if (!snap.exists) return none('no_data');
    target = snap.data();
    forName = target.displayName || null;
  }

  if (!target) return none('no_data');

  return {
    ...base,
    ...intakeAdvice({
      bmi: target.bmi,
      heightCm: target.heightCm,
      weightKg: target.weightKg,
      age: target.age,
      gender: target.gender,
    }, settings),
    // 家長看的是孩子的數字，介面要講清楚是誰的
    forName,
  };
}

module.exports = { getTodayMenu };
