/**
 * 每月菜單同步：抓 Google 試算表（經 Apps Script）→ 驗證 → 寫入 daily_menu。
 *
 * ## 資料表設計：以日期為主鍵
 *
 * 「每月日期與星期都不同」之所以麻煩，是因為直覺會想用月曆格狀排。
 * 改成一列一天、日期當主鍵之後問題就消失了：星期由日期推導，
 * 表上的星期欄只用來**核對**——插入或刪除列造成日期錯位，
 * 是月菜單最常見也最安靜的錯誤，不比對就不會有人發現。
 *
 * ## 供餐只有週一到週五
 *
 * 週六日出現在表上一律視為錯誤（多半是手動貼上貼歪了）。
 * 週一到五當中不供餐的日子（段考、校外教學、國定假日）
 * 由「供餐」欄明寫，寫入 isActive=false——
 * 從「那天沒有列」去推斷不供餐是不安全的，整列不見也可能只是忘了填。
 */
const { db } = require('../config/firebase');
const { COL, MENU_SLOTS, SLOT_LABEL, SLOT_CATEGORY, TUNABLE_DEFAULTS } = require('../config/schema');

const SHEET_URL = process.env.MENU_SHEET_URL || '';
const SHEET_TOKEN = process.env.MENU_SHEET_TOKEN || '';
/**
 * Apps Script 的回應是兩段式的：script.google.com 先回 302 轉址，
 * 真正的內容在 script.googleusercontent.com。再加上網頁應用程式的冷啟動，
 * 整趟經常超過 20 秒——而執行紀錄只會顯示 doGet 已完成，看起來像我們這邊的問題。
 * 因此預設給 60 秒。這是管理員按按鈕觸發的動作，不是使用者等待中的頁面。
 */
const FETCH_TIMEOUT_MS = Number(process.env.MENU_SHEET_TIMEOUT_MS || 60000);
const MAX_ROWS = Number(process.env.MENU_SHEET_MAX_ROWS || 400);

const norm = (v) => String(v == null ? '' : v).trim();

const WEEKDAY_TEXT = ['日', '一', '二', '三', '四', '五', '六'];

/** 自動建立菜色時，每個分類的起始份量（公克/人）。建立後請管理員複核。 */
const DEFAULT_PORTION_G = {
  主食: 120, 主菜: 90, 副菜: 65, 蔬菜: 80, 湯品: 200,
};

function configured() {
  return Boolean(SHEET_URL && SHEET_TOKEN);
}

/**
 * 'YYYY-MM-DD' → 星期幾（0=日）。
 *
 * 刻意自己拆字串而不是 new Date(str)：後者會被當成 UTC 解析，
 * 在 UTC+8 會把日期算成前一天。這個專案先前就踩過這個坑。
 */
function weekdayOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm(ymd));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1
      || d.getDate() !== Number(m[3])) {
    return null;                                 // 2026-02-30 這種不存在的日期
  }
  return d.getDay();
}

/** 列號會直接內插進前端報告，所以在這裡就釘成安全整數（試算表回什麼都不信）。 */
function rowNum(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e6 ? n : 0;
}

async function fetchMenus(month) {
  if (!configured()) {
    const err = new Error('尚未設定 MENU_SHEET_URL 與 MENU_SHEET_TOKEN');
    err.status = 400;
    throw err;
  }

  const sep = SHEET_URL.includes('?') ? '&' : '?';
  const q = `token=${encodeURIComponent(SHEET_TOKEN)}`
    + (month ? `&month=${encodeURIComponent(month)}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // 計時器要一路保護到「內容讀完」為止。
  // 原本在拿到標頭後就 clearTimeout，於是標頭回來、內容卻卡住時會無限等下去。
  let text;
  try {
    const res = await fetch(`${SHEET_URL}${sep}${q}`,
      { signal: controller.signal, redirect: 'follow' });
    text = await res.text();
  } catch (error) {
    const err = new Error(
      error.name === 'AbortError'
        ? `試算表沒有在 ${FETCH_TIMEOUT_MS}ms 內回應。`
          + 'Apps Script 會先回 302 轉址到 script.googleusercontent.com，'
          + '內容在第二段才拿得到，所以執行紀錄顯示「已完成」仍可能逾時。'
          + `請看執行紀錄的「持續時間」：超過 ${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒`
          + '就調高 MENU_SHEET_TIMEOUT_MS；'
          + '若遠低於此，多半是網路擋掉了 script.googleusercontent.com。'
        : `無法連線試算表：${error.message}`
    );
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const err = new Error(
      text.includes('<!DOCTYPE') || text.includes('accounts.google.com')
        ? '試算表回傳的是登入頁面，請確認 Apps Script 部署時「誰可以存取」選了「任何人」'
        : `試算表回應不是 JSON（前 80 字：${text.slice(0, 80)}）`
    );
    err.status = 502;
    throw err;
  }

  if (!body.ok) {
    const err = new Error(`試算表回報錯誤：${body.error || '未知'}`);
    err.status = body.error === '未授權' ? 401 : 502;
    throw err;
  }
  if (!Array.isArray(body.menus)) {
    const err = new Error('試算表回應缺少 menus 陣列');
    err.status = 502;
    throw err;
  }
  body.menus = body.menus.map((m) => ({ ...m, rowNumber: rowNum(m.rowNumber) }));
  return body;
}

/** 「供餐」欄怎麼算有供餐：留空或填否/休/停/X 都算沒有。 */
function isServed(raw) {
  const v = norm(raw).toUpperCase();
  if (!v) return false;
  if (['否', '無', '休', '停', 'N', 'NO', 'X', '-'].includes(v)) return false;
  return true;
}

/**
 * 驗證單列。回傳 { ok, value } 或 { ok:false, reason }。
 */
function validateRow(row) {
  const date = norm(row.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const raw = norm(row.rawDate) || date;
    return { ok: false, reason: `日期格式不正確：${raw || '(空白)'}，請用 2026-11-02 這種寫法` };
  }

  const dow = weekdayOf(date);
  if (dow === null) return { ok: false, reason: `日期不存在：${date}` };
  if (dow === 0 || dow === 6) {
    return { ok: false, reason: `${date} 是星期${WEEKDAY_TEXT[dow]}，只供餐週一到週五` };
  }

  // 星期欄只用來核對。對不上通常代表有人插入或刪除了列，日期整段推移了。
  const written = norm(row.weekdayText).replace(/^週|^星期/, '');
  if (written && written !== WEEKDAY_TEXT[dow]) {
    return {
      ok: false,
      reason: `${date} 是星期${WEEKDAY_TEXT[dow]}，但表上寫星期${written}（可能有列被插入或刪除）`,
    };
  }

  const served = isServed(row.served);
  const out = { date, weekday: dow, served, note: norm(row.note), dishNames: {} };

  if (!served) return { ok: true, value: out };   // 不供餐的日子不必填菜

  const missing = [];
  MENU_SLOTS.forEach((slot) => {
    const name = norm(row[slot]);
    if (!name) missing.push(SLOT_LABEL[slot] || slot);
    out.dishNames[slot] = name;
  });
  if (missing.length) {
    return { ok: false, reason: `供餐日但缺少：${missing.join('、')}` };
  }
  return { ok: true, value: out };
}

/** 菜名 → 菜色。菜名在試算表裡是人輸入的，比對前先正規化空白。 */
async function loadDishesByName() {
  const snap = await db.collection(COL.dishes).get();
  const byName = new Map();
  snap.docs.forEach((d) => {
    const dish = { id: d.id, ...d.data() };
    const name = norm(dish.name).replace(/\s+/g, '');
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(dish);
  });
  return byName;
}

const dishKey = (name) => norm(name).replace(/\s+/g, '');

/**
 * 新菜色的起始資料。
 *
 * 營養值取分類預設（與 E 幣公式用的是同一份），份量取上面的起始值，
 * 並標記 needsReview —— 這些數字會直接影響供應量與發幣，
 * 自動建立只是為了不讓排菜卡住，不是說它們已經正確。
 */
function newDishData(name, slot) {
  const category = SLOT_CATEGORY[slot] || '主菜';
  const nut = (TUNABLE_DEFAULTS.nutrition.byCategory || {})[category]
    || TUNABLE_DEFAULTS.nutrition.fallback;
  return {
    name: norm(name),
    category,
    portionG: DEFAULT_PORTION_G[category] || 90,
    unitCost: 0,
    emissionFactor: 0,
    proteinPerKg: nut.proteinPerKg,
    fiberPerKg: nut.fiberPerKg,
    needsReview: true,
    createdFrom: 'menu_sync',
  };
}

module.exports = {
  configured,
  rowNum,
  fetchMenus,
  validateRow,
  loadDishesByName,
  newDishData,
  dishKey,
  weekdayOf,
  isServed,
  norm,
  WEEKDAY_TEXT,
  DEFAULT_PORTION_G,
  MAX_ROWS,
};
