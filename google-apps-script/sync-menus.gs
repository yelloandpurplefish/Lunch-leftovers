/**
 * 每月菜單匯出 —— Google Apps Script 網頁應用程式
 * ==================================================================
 *
 * ## 為什麼和學生名冊分開部署
 *
 * 菜單通常由營養師或廚房維護，名冊由註冊組維護。分成兩份指令碼、
 * 兩組密鑰、兩個試算表，排菜的人就拿不到學生的 Gmail 與身高體重。
 * 同一套系統裡「技術員碰不到學生資料」也是同樣的道理。
 *
 * ## 資料表設計：一列一天，日期當主鍵
 *
 * 排菜直覺上會想用月曆格狀（週一～週五當欄、週次當列），但那種表
 * 每個月格子位置都在變，一天還要佔六列放六道菜，解析極易出錯。
 * 改成一列一天之後，「每月日期與星期都不同」這件事就不再是問題——
 * 星期可以由日期推導，表上留著只是給人核對。
 *
 *   日期 | 星期 | 供餐 | 主食 | 主菜 | 副菜一 | 副菜二 | 蔬菜 | 湯品 | 備註
 *
 *  · 日期：主鍵。可以是真正的日期儲存格，也可以是 2026-11-02 這種文字。
 *  · 星期：由「排菜工具」自動填，後端會**比對它和日期是否相符**。
 *          插入或刪除列造成日期錯位，是月菜單最常見也最安靜的錯誤。
 *  · 供餐：留空或填「否」代表那天不供餐（段考、校外教學、國定假日）。
 *          明寫比「從缺列推斷」可靠——整列不見可能只是忘了填。
 *  · 只放週一到週五。排菜工具不會產生週末的列。
 *
 * ## 部署步驟
 *
 *  1. 開啟菜單試算表 → 擴充功能 → Apps Script，貼上這份檔案
 *  2. 專案設定 → 指令碼屬性 → MENU_SYNC_TOKEN = （自己產生的亂碼，≥32 字元）
 *  3. 部署 → 新增部署作業 → 網頁應用程式
 *       執行身分：我　／　誰可以存取：任何人
 *       （後端是機器，沒有 Google 帳號可登入；安全性由密鑰負責）
 *  4. 把網址與密鑰填進後端 .env：
 *       MENU_SHEET_URL=https://script.google.com/macros/s/AKfy..../exec
 *       MENU_SHEET_TOKEN=（與 MENU_SYNC_TOKEN 相同）
 *
 * ## 每個月怎麼排
 *
 * 試算表上方會多出「🍱 排菜工具」選單：
 *   · 產生下個月的日期列 —— 自動補上該月所有週一～週五，星期填好
 *   · 產生指定月份 —— 自己輸入年月
 * 產生後只要填菜名即可。已經存在的日期不會被覆蓋。
 */

var FIELDS = {
  '日期': 'date',
  '星期': 'weekdayText',
  '供餐': 'served',
  '主食': 'staple',
  '主菜': 'main',
  '副菜一': 'side1',
  '副菜二': 'side2',
  '蔬菜': 'veg',
  '湯品': 'soup',
  '備註': 'note'
};

/** 必要欄位。備註可有可無。 */
var REQUIRED_TITLES = ['日期', '星期', '供餐', '主食', '主菜', '副菜一', '副菜二', '蔬菜', '湯品'];

var SHEET_NAME = '菜單';
var WEEKDAY_TEXT = ['日', '一', '二', '三', '四', '五', '六'];

// ── 對外：後端來抓 ────────────────────────────────────────────────

function doGet(e) {
  var params = (e && e.parameter) || {};
  var expected = PropertiesService.getScriptProperties().getProperty('MENU_SYNC_TOKEN');
  if (!expected) {
    return json({ ok: false, error: '尚未設定 MENU_SYNC_TOKEN 指令碼屬性' });
  }
  if (String(params.token || '') !== expected) {
    return json({ ok: false, error: '未授權' });
  }

  try {
    var rows = readMenu(String(params.month || ''));
    return json({
      ok: true,
      sheet: sheet_().getName(),
      timeZone: tz_(),
      exportedAt: Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm:ssXXX"),
      month: params.month || null,
      count: rows.length,
      menus: rows
    });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!s) throw new Error('找不到工作表「' + SHEET_NAME + '」');
  return s;
}

/** 試算表自己的時區。用它格式化日期，才不會因為 UTC 換算差一天。 */
function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()
    || Session.getScriptTimeZone();
}

/**
 * 讀出菜單。month 給 'YYYY-MM' 就只回傳那個月，留空回傳整張表。
 */
function readMenu(month) {
  var s = sheet_();
  var values = s.getDataRange().getValues();
  if (values.length < 2) return [];

  var header = values[0];
  var colOf = {};
  for (var c = 0; c < header.length; c++) {
    var title = String(header[c]).trim();
    if (FIELDS[title]) colOf[FIELDS[title]] = c;
  }

  var missing = [];
  for (var i = 0; i < REQUIRED_TITLES.length; i++) {
    var t = REQUIRED_TITLES[i];
    if (colOf[FIELDS[t]] === undefined) missing.push(t);
  }
  if (missing.length) throw new Error('試算表缺少欄位：' + missing.join('、'));

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var dateCell = row[colOf.date];
    var date = toYmd_(dateCell);

    if (!date) {
      // 解析不出日期時要分兩種情況：
      //   整列都空 → 空白列或分隔列，靜默略過
      //   有填菜名 → 日期打錯了，照樣送出去讓後端報錯
      // 否則打錯日期的那一天會無聲消失，管理員只會發現「少了一天」卻不知為何。
      var hasContent = false;
      for (var k in colOf) {
        if (k === 'date') continue;
        if (text_(row[colOf[k]]) !== '') { hasContent = true; break; }
      }
      if (!hasContent) continue;
      out.push({
        rowNumber: r + 1,
        date: '',
        rawDate: text_(dateCell),
        weekdayText: text_(row[colOf.weekdayText]),
        served: text_(row[colOf.served]),
        staple: '', main: '', side1: '', side2: '', veg: '', soup: '',
        note: colOf.note === undefined ? '' : text_(row[colOf.note])
      });
      continue;
    }

    if (month && date.indexOf(month) !== 0) continue;

    out.push({
      rowNumber: r + 1,
      date: date,
      weekdayText: text_(row[colOf.weekdayText]),
      served: text_(row[colOf.served]),
      staple: text_(row[colOf.staple]),
      main: text_(row[colOf.main]),
      side1: text_(row[colOf.side1]),
      side2: text_(row[colOf.side2]),
      veg: text_(row[colOf.veg]),
      soup: text_(row[colOf.soup]),
      note: colOf.note === undefined ? '' : text_(row[colOf.note])
    });
  }
  return out;
}

/**
 * 儲存格 → 'YYYY-MM-DD'。
 * 用試算表的時區格式化；直接拿 toISOString 會在 UTC+8 把日期變成前一天。
 */
function toYmd_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (!m) return '';
  return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
}

function pad_(n) { return ('0' + n).slice(-2); }
function text_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── 試算表上的排菜工具 ────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🍱 排菜工具')
    .addItem('產生下個月的日期列', 'fillNextMonth')
    .addItem('產生指定月份…', 'fillChosenMonth')
    .addSeparator()
    .addItem('檢查日期與星期是否相符', 'verifyWeekdays')
    .addToUi();
}

function fillNextMonth() {
  var now = new Date();
  var next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  fillMonth_(next.getFullYear(), next.getMonth() + 1);
}

function fillChosenMonth() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('產生月份', '請輸入年月，例如 2026-11', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var m = String(res.getResponseText()).trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) { ui.alert('格式不對，請輸入像 2026-11 這樣的年月'); return; }
  fillMonth_(Number(m[1]), Number(m[2]));
}

/**
 * 補上某個月所有「週一到週五」的列。
 *
 * 已經存在的日期不會動——排到一半重新產生，不該把填好的菜名蓋掉。
 */
function fillMonth_(year, month) {
  var s = sheet_();
  var values = s.getDataRange().getValues();
  var header = values[0] || [];

  var colOf = {};
  for (var c = 0; c < header.length; c++) {
    var title = String(header[c]).trim();
    if (FIELDS[title]) colOf[FIELDS[title]] = c;
  }
  if (colOf.date === undefined || colOf.weekdayText === undefined) {
    SpreadsheetApp.getUi().alert('請先建立標題列：' + REQUIRED_TITLES.join('、'));
    return;
  }

  var existing = {};
  for (var r = 1; r < values.length; r++) {
    var d = toYmd_(values[r][colOf.date]);
    if (d) existing[d] = true;
  }

  var width = Math.max(header.length, Object.keys(FIELDS).length);
  var toAppend = [];
  var cursor = new Date(year, month - 1, 1);
  while (cursor.getMonth() === month - 1) {
    var dow = cursor.getDay();
    if (dow >= 1 && dow <= 5) {                       // 只排週一到週五
      var ymd = Utilities.formatDate(cursor, tz_(), 'yyyy-MM-dd');
      if (!existing[ymd]) {
        var line = new Array(width).fill('');
        line[colOf.date] = ymd;
        line[colOf.weekdayText] = WEEKDAY_TEXT[dow];
        if (colOf.served !== undefined) line[colOf.served] = 'V';   // 預設供餐，不供餐再自己清掉
        toAppend.push(line);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!toAppend.length) {
    SpreadsheetApp.getUi().alert(year + ' 年 ' + month + ' 月的日期列都已經存在了。');
    return;
  }
  s.getRange(s.getLastRow() + 1, 1, toAppend.length, width).setValues(toAppend);
  SpreadsheetApp.getUi().alert(
    '已補上 ' + year + ' 年 ' + month + ' 月的 ' + toAppend.length + ' 個上學日，請填入菜名。');
}

/** 日期與星期對不上通常代表有人插入或刪除了列，把下面的日期全推移了。 */
function verifyWeekdays() {
  var s = sheet_();
  var values = s.getDataRange().getValues();
  var header = values[0] || [];
  var colOf = {};
  for (var c = 0; c < header.length; c++) {
    var title = String(header[c]).trim();
    if (FIELDS[title]) colOf[FIELDS[title]] = c;
  }

  var bad = [];
  for (var r = 1; r < values.length; r++) {
    var ymd = toYmd_(values[r][colOf.date]);
    if (!ymd) continue;
    var parts = ymd.split('-');
    var real = WEEKDAY_TEXT[new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay()];
    var written = text_(values[r][colOf.weekdayText]).replace('週', '').replace('星期', '');
    if (written && written !== real) {
      bad.push('第 ' + (r + 1) + ' 列：' + ymd + ' 是星期' + real + '，表上寫星期' + written);
    }
  }

  SpreadsheetApp.getUi().alert(
    bad.length ? '發現 ' + bad.length + ' 列對不上：\n\n' + bad.join('\n')
               : '日期與星期全部相符。');
}

/** 在編輯器裡直接執行，可先確認格式對不對（結果看「執行記錄」）。 */
function testReadMenu() {
  var rows = readMenu('');
  Logger.log('讀到 ' + rows.length + ' 天');
  Logger.log(JSON.stringify(rows.slice(0, 3), null, 2));
}
