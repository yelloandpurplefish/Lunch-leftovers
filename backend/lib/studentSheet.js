/**
 * 學生名冊同步：抓 Google 試算表（經 Apps Script）→ 驗證 → 算 BMI → 寫入 users。
 *
 * ## 身分的錨點是 Gmail，不是學號
 *
 * 這套系統之後會全面改用 Google 登入，屆時使用者的身分由 Google 帳號決定。
 * 所以比對既有學生一律用 **Gmail**：學號會因為轉學、重新編班而變，
 * Gmail 不會。學號仍然存進 `account`（現有的帳號登入路徑要用），
 * 但它不是判斷「這是不是同一個人」的依據。
 *
 * 同步建立的帳號**沒有密碼**，因此目前無法用帳密登入——這是預期的，
 * Google 登入上線後它們才會真正可用。login 已經會擋掉沒有 passwordHash
 * 的帳號（回 401），不會因此出錯。
 *
 * ## 不碰的東西
 *
 * 幣、角色、密碼、以及「試算表裡沒有的學生」一律不動。
 * 同步只覆寫明確來自試算表的欄位，其餘保持原樣——
 * 匯出不完整或篩選錯誤時才不會誤傷。
 */
const { db } = require('../config/firebase');
const { COL, ROLES, COIN_HOLDER_ROLES } = require('../config/schema');

const SHEET_URL = process.env.STUDENT_SHEET_URL || '';
const SHEET_TOKEN = process.env.STUDENT_SHEET_TOKEN || '';
/**
 * Apps Script 的回應是兩段式的：script.google.com 先回 302 轉址，
 * 真正的內容在 script.googleusercontent.com。再加上網頁應用程式的冷啟動，
 * 整趟經常超過 20 秒——而執行紀錄只會顯示 doGet 已完成，看起來像我們這邊的問題。
 * 因此預設給 60 秒。這是管理員按按鈕觸發的動作，不是使用者等待中的頁面。
 */
const FETCH_TIMEOUT_MS = Number(process.env.STUDENT_SHEET_TIMEOUT_MS || 60000);

/** 一次同步最多處理幾筆，避免一張壞掉的表把整個流程拖垮。 */
const MAX_ROWS = Number(process.env.STUDENT_SHEET_MAX_ROWS || 2000);

const norm = (v) => String(v == null ? '' : v).trim();
const lower = (v) => norm(v).toLowerCase();

function configured() {
  return Boolean(SHEET_URL && SHEET_TOKEN);
}

/** 合理範圍。超出的多半是單位填錯（公尺當公分、公克當公斤）或打錯字。 */
const RANGE = {
  heightCm: [80, 220],
  weightKg: [15, 200],
  age: [3, 25],
};

/**
 * BMI = 體重(kg) ÷ 身高(m)²
 *
 * 回傳值刻意只到小數一位：量測本身的誤差遠大於小數第二位，
 * 多給位數只會讓人以為它比實際精確。
 */
function computeBmi(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) return null;
  const m = h / 100;
  return Math.round((w / (m * m)) * 10) / 10;
}

/** 從 Apps Script 取回名冊。 */
/** 列號會直接內插進前端報告，所以在這裡就釘成安全整數（試算表回什麼都不信）。 */
function rowNum(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e6 ? n : 0;
}

async function fetchRoster() {
  if (!configured()) {
    const err = new Error('尚未設定 STUDENT_SHEET_URL 與 STUDENT_SHEET_TOKEN');
    err.status = 400;
    throw err;
  }

  const url = `${SHEET_URL}${SHEET_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(SHEET_TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // 計時器要一路保護到「內容讀完」為止。
  // 原本在拿到標頭後就 clearTimeout，於是標頭回來、內容卻卡住時會無限等下去。
  let text;
  try {
    // Apps Script 會 302 轉址到 googleusercontent，fetch 預設會跟隨
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    text = await res.text();
  } catch (error) {
    const err = new Error(
      error.name === 'AbortError'
        ? `試算表沒有在 ${FETCH_TIMEOUT_MS}ms 內回應。`
          + 'Apps Script 會先回 302 轉址到 script.googleusercontent.com，'
          + '內容在第二段才拿得到，所以執行紀錄顯示「已完成」仍可能逾時。'
          + `請看執行紀錄的「持續時間」：超過 ${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒`
          + '就調高 STUDENT_SHEET_TIMEOUT_MS；'
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
    // 最常見的狀況：部署時「誰可以存取」沒選「任何人」，
    // Google 會回一頁登入 HTML 而不是 JSON。直接講清楚，別讓人去猜。
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
  if (!Array.isArray(body.students)) {
    const err = new Error('試算表回應缺少 students 陣列');
    err.status = 502;
    throw err;
  }
  body.students = (body.students || []).map((s) => ({ ...s, rowNumber: rowNum(s.rowNumber) }));
  return body;
}

/**
 * 驗證單列。回傳 { ok, value } 或 { ok:false, reason }。
 * 所有錯誤都帶上試算表的列號，管理員才知道要去改哪一列。
 */
function validateRow(row) {
  const gmail = lower(row.gmail);
  const studentNo = norm(row.studentNo);
  const displayName = norm(row.displayName);
  const className = norm(row.className);
  const seatNo = norm(row.seatNo);

  if (!gmail) return { ok: false, reason: '缺少 Gmail' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail)) return { ok: false, reason: `Gmail 格式不正確：${gmail}` };
  if (!studentNo) return { ok: false, reason: '缺少學號' };
  if (!displayName) return { ok: false, reason: '缺少姓名' };
  if (!className) return { ok: false, reason: '缺少班級' };
  if (!seatNo) return { ok: false, reason: '缺少座號' };

  const out = { gmail, studentNo, displayName, className, seatNo, gender: norm(row.gender) };

  // 身高體重缺一就不算 BMI，但其餘欄位照樣同步——
  // 名冊本身有用，不該因為沒量身高就整列丟掉。
  for (const [field, label] of [['age', '年齡'], ['heightCm', '身高'], ['weightKg', '體重']]) {
    const raw = row[field];
    if (raw === null || raw === undefined || raw === '') {
      out[field] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: `${label}不是數字：${raw}` };
    const [lo, hi] = RANGE[field];
    if (n < lo || n > hi) {
      return { ok: false, reason: `${label} ${n} 超出合理範圍 ${lo}–${hi}，請確認單位` };
    }
    out[field] = n;
  }

  out.bmi = computeBmi(out.heightCm, out.weightKg);
  return { ok: true, value: out };
}

/** 班名 → 班級。試算表只有「班級」沒有「年級」，所以用班名查。 */
async function loadClassesByName() {
  const snap = await db.collection(COL.classes).get();
  const byName = new Map();
  snap.docs.forEach((d) => {
    const c = d.data();
    const name = norm(c.name);
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ id: d.id, ...c });
  });
  return byName;
}

/**
 * 一次撈完所有使用者再比對，避免每列查一次。
 *
 * 除了 Gmail 索引之外也回傳完整清單：「資料庫有、試算表沒有」的報告
 * 必須涵蓋**沒有 email 的學生**（例如管理員手動建立的），
 * 否則那些人會從報告裡消失，而他們正是最需要被看到的。
 */
async function loadUsers() {
  const snap = await db.collection(COL.users).get();
  const byEmail = new Map();
  const accounts = new Set();
  const all = [];
  snap.docs.forEach((d) => {
    const u = { id: d.id, ...d.data() };
    all.push(u);
    if (u.account) accounts.add(lower(u.account));
    const e = lower(u.email);
    if (!e) return;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(u);
  });
  return { byEmail, accounts, all };
}

module.exports = {
  rowNum,
  configured,
  computeBmi,
  validateRow,
  fetchRoster,
  loadClassesByName,
  loadUsers,
  norm,
  lower,
  RANGE,
  MAX_ROWS,
  SHEET_URL,
};
