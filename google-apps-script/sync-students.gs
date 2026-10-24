/**
 * 學生名冊匯出 —— Google Apps Script 網頁應用程式
 * ==================================================================
 *
 * 把 Google 試算表的學生名冊，以 JSON 形式提供給後端的「同步」按鈕抓取。
 *
 * ## 為什麼是「後端來抓」而不是「Apps Script 推過去」
 *
 * 推送需要在 Apps Script 裡存後端的管理員憑證，而 Apps Script 的
 * 指令碼屬性任何有編輯權的人都看得到。改成後端主動抓，
 * 這支程式就只需要一個唯讀的共用密鑰，外洩的後果僅限於「名冊被讀走」，
 * 不會變成「有人能寫進資料庫」。
 *
 * ## 部署步驟
 *
 *  1. 開啟學生名冊試算表 → 擴充功能 → Apps Script
 *  2. 把這份檔案的內容整個貼上，存檔
 *  3. 左側「專案設定」→ 指令碼屬性 → 新增一筆：
 *       SYNC_TOKEN = （自己產生一串亂碼，至少 32 字元）
 *  4. 右上「部署」→ 新增部署作業 → 類型選「網頁應用程式」
 *       執行身分：我
 *       誰可以存取：**任何人**
 *       （選「任何人」是必要的：後端是機器，沒有 Google 帳號可以登入。
 *         安全性由上面那組密鑰負責，沒有密鑰就只會拿到 401。）
 *  5. 複製產生的網址，連同密鑰填進後端的 .env：
 *       STUDENT_SHEET_URL=https://script.google.com/macros/s/AKfy..../exec
 *       STUDENT_SHEET_TOKEN=（與 SYNC_TOKEN 相同）
 *
 * ## 試算表格式
 *
 * 第一列是標題列，欄位名稱必須與下面的 FIELDS 對得上（順序可以不同，
 * 多餘的欄位會被忽略）：
 *
 *   Gmail | 學號 | 班級 | 座號 | 姓名 | 性別 | 年齡 | 身高 | 體重
 *
 * 身高單位是公分、體重是公斤。BMI 不必放在試算表裡，由後端計算後存入資料庫。
 *
 * ## 測試
 *
 * 部署後在瀏覽器打開（把 TOKEN 換成你的密鑰）：
 *   https://script.google.com/macros/s/..../exec?token=TOKEN&limit=3
 * 應該會看到前三筆的 JSON。
 */

/** 標題列的欄位名稱 → 回傳 JSON 的鍵。改試算表標題時改這裡就好。 */
var FIELDS = {
  'Gmail': 'gmail',
  '學號': 'studentNo',
  '班級': 'className',
  '座號': 'seatNo',
  '姓名': 'displayName',
  '性別': 'gender',
  '年齡': 'age',
  '身高': 'heightCm',
  '體重': 'weightKg'
};

/** 名冊所在的工作表。留空就用第一個工作表。 */
var SHEET_NAME = '';

function doGet(e) {
  var params = (e && e.parameter) || {};

  // 密鑰比對。Apps Script 沒有定時比較的工具，但這支只回傳名冊、
  // 不接受寫入，側信道猜密鑰的代價遠高於直接去要一份名冊。
  var expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!expected) {
    return json({ ok: false, error: '尚未設定 SYNC_TOKEN 指令碼屬性' }, 500);
  }
  if (String(params.token || '') !== expected) {
    return json({ ok: false, error: '未授權' }, 401);
  }

  try {
    var rows = readRoster(Number(params.limit) || 0);
    return json({
      ok: true,
      sheet: sheetName(),
      exportedAt: new Date().toISOString(),
      count: rows.length,
      students: rows
    });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function sheetName() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) throw new Error('找不到工作表：' + SHEET_NAME);
  return sheet.getName();
}

/**
 * 讀出名冊。
 *
 * 刻意一次 getValues() 把整張表讀進記憶體再處理：Apps Script 每次
 * 跨服務呼叫都很慢，逐格讀取在三十個人的表上就會明顯卡頓。
 */
function readRoster(limit) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) throw new Error('找不到工作表：' + SHEET_NAME);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  // 標題列 → 欄位索引
  var header = values[0];
  var colOf = {};
  for (var c = 0; c < header.length; c++) {
    var title = String(header[c]).trim();
    if (FIELDS[title]) colOf[FIELDS[title]] = c;
  }

  var missing = [];
  for (var title2 in FIELDS) {
    if (colOf[FIELDS[title2]] === undefined) missing.push(title2);
  }
  if (missing.length) {
    throw new Error('試算表缺少欄位：' + missing.join('、'));
  }

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];

    // 整列皆空就跳過（表尾常有空白列）
    var hasContent = false;
    for (var k in colOf) {
      if (String(row[colOf[k]]).trim() !== '') { hasContent = true; break; }
    }
    if (!hasContent) continue;

    out.push({
      rowNumber: r + 1,          // 試算表上看到的列號，方便對照修正
      gmail: text(row[colOf.gmail]),
      studentNo: text(row[colOf.studentNo]),
      className: text(row[colOf.className]),
      seatNo: text(row[colOf.seatNo]),
      displayName: text(row[colOf.displayName]),
      gender: text(row[colOf.gender]),
      age: num(row[colOf.age]),
      heightCm: num(row[colOf.heightCm]),
      weightKg: num(row[colOf.weightKg])
    });

    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

/** 儲存格 → 字串。數字型的學號與座號會被讀成 123.0，要去掉小數點。 */
function text(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).trim();
}

/** 儲存格 → 數字。空白或非數字回 null，讓後端決定要不要擋。 */
function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  var n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
}

function json(obj, status) {
  // Apps Script 的網頁應用程式一律回 200，狀態碼放在內容裡讓後端判讀
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 在 Apps Script 編輯器裡直接執行這個函式，可以不經網路先驗證
 * 試算表格式對不對（結果看「執行記錄」）。
 */
function testReadRoster() {
  var rows = readRoster(3);
  Logger.log('讀到 ' + rows.length + ' 筆');
  Logger.log(JSON.stringify(rows, null, 2));
}
