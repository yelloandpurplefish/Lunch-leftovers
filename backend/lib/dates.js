/**
 * 日期字串工具。`date` 欄位一律是**學校所在時區的日曆日** `YYYY-MM-DD`。
 *
 * 不要用 `new Date().toISOString().slice(0,10)`：在 UTC+8，本地 00:00–08:00 會得到
 * 「昨天」，而 `setHours(0,0,0,0)` 之後再 `toISOString()` 更是一定少一天，
 * 會造成當天的場次/勾選/簽到對不到同一個 key。
 */

const pad = (n) => String(n).padStart(2, '0');

/** Date → 本地日曆日 `YYYY-MM-DD`（預設今天）。*/
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天（本地）。*/
function today() {
  return ymd();
}

/** `YYYY-MM-DD` → 本地午夜的 Date（可安全做加減與取 getDay）。*/
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) {
    const fallback = new Date(s);
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** n 天前（本地）的日曆日；n=0 即今天。*/
function daysAgo(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return ymd(d);
}

/** 連續日期陣列（含頭含尾），用於剩餘量曲線補零。*/
function rangeYmd(sinceYmd, days) {
  const start = parseYmd(sinceYmd);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(ymd(d));
  }
  return out;
}

/** 是否為合法的 `YYYY-MM-DD`。*/
function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

module.exports = { ymd, today, parseYmd, daysAgo, rangeYmd, isYmd };
