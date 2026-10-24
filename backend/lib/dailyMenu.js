/**
 * 當日菜單的讀取（daily_menu + dishes 的組裝）。
 *
 * 抽出來是因為有兩個地方需要「今天到底有哪幾道菜」：
 *   · 首頁的今日菜單（menuController）
 *   · 今日菜色問卷的驗證（taskController）—— 問卷只能選今天真的出現過的菜，
 *     否則廚房收到的回饋會指向根本沒供應的菜色
 * 兩邊若各自查一次，日後菜單結構一改就會有一邊忘了跟上。
 */
const { db } = require('../config/firebase');
const { COL, MENU_SLOTS, SLOT_LABEL } = require('../config/schema');

/**
 * @returns {Promise<{date:string, served:boolean, note:string, menuId:string|null,
 *                    dishes:Array<{slot,label,dishId,name,category,portionG,needsReview}>}>}
 * 查無菜單不是錯誤：段考、校外教學本來就沒有供餐，回 served:false。
 */
async function getDayMenu(date) {
  const snap = await db.collection(COL.dailyMenu).doc(date).get();
  const menu = snap.exists ? snap.data() : null;
  const served = Boolean(menu && menu.isActive !== false && menu.dishes);

  if (!served) {
    return {
      date,
      served: false,
      note: menu ? (menu.note || '') : '',
      menuId: menu ? (menu.menuId || snap.id) : null,
      dishes: [],
    };
  }

  const slots = MENU_SLOTS
    .map((slot) => ({ slot, dishId: menu.dishes[slot] }))
    .filter((x) => x.dishId);

  const unique = [...new Set(slots.map((x) => x.dishId))];
  const snaps = unique.length
    ? await db.getAll(...unique.map((id) => db.collection(COL.dishes).doc(id)))
    : [];
  const byId = new Map();
  snaps.forEach((s) => { if (s.exists) byId.set(s.id, s.data()); });

  return {
    date,
    served: true,
    note: menu.note || '',
    menuId: menu.menuId || snap.id,
    dishes: slots.map(({ slot, dishId }) => {
      const d = byId.get(dishId) || {};
      return {
        slot,
        label: SLOT_LABEL[slot] || slot,
        dishId,
        name: d.name || '（查無此菜色）',
        category: d.category || null,
        portionG: Number(d.portionG || 0) || null,
        needsReview: Boolean(d.needsReview),
      };
    }),
  };
}

/**
 * 問卷驗證用：當日可選的菜名集合。
 * 比對前把前後空白收掉——下拉選單送回來的值理論上一字不差，
 * 但手動打 API 的、或日後換成自由輸入時，不該因為一個空白就被拒。
 */
async function dishNameSet(date) {
  const menu = await getDayMenu(date);
  return {
    served: menu.served,
    names: new Set(menu.dishes.map((d) => String(d.name).trim())),
    menu,
  };
}

module.exports = { getDayMenu, dishNameSet };
