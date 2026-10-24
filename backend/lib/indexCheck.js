/**
 * 啟動時檢查 firestore.indexes.json 裡的複合索引是否都已建立。
 *
 * ## 為什麼是「發查詢去試」而不是「列出索引」
 *
 * firebase-admin 沒有列出索引的 API（索引管理屬於 Firestore Admin REST API
 * 或 gcloud / firebase CLI）。但我們要的東西剛好只有查詢拿得到：
 * **缺索引時 Firestore 回的錯誤訊息裡就包含建立索引的連結。**
 * 所以做法是照每個索引定義組一個最省的探測查詢（limit(1)），
 * 接住 FAILED_PRECONDITION，把裡面的連結原樣印到日誌。
 *
 * ## 模擬器不強制索引
 *
 * 本機 emulator 不檢查複合索引（任何查詢都會成功），所以在模擬器上
 * 這個檢查**只能驗證查詢形狀寫得出來**，不能證明索引存在。
 * 日誌會明講這一點，否則本機一片綠燈會讓人誤以為正式環境也沒問題。
 *
 * ## 探測查詢怎麼組
 *
 * 複合索引 (a ASC, b ASC, c DESC) 對應的查詢形狀是
 * `where(a,'==',…).where(b,'==',…).orderBy(c,'desc')`
 * ——也就是除了最後一個欄位都當等值條件，最後一個當排序。
 * 這正是這些索引被設計出來服務的形狀。等值用一個不會命中的哨兵值，
 * 所以探測不會讀到真實資料，成本是每個索引最多 1 筆讀取。
 *
 * 用 INDEX_CHECK=off 可以關掉（例如不希望啟動時對正式庫發查詢）。
 */
const fs = require('fs');
const path = require('path');

/** 不會命中任何資料的哨兵值。索引需求只看查詢形狀，與值無關。 */
const PROBE_VALUE = '__index_probe_no_match__';
const INDEX_FILE = path.join(__dirname, '..', '..', 'firestore.indexes.json');

/** 從 Firestore 的錯誤訊息裡挖出建立索引的連結。 */
function extractIndexUrl(message) {
  const m = String(message || '').match(
    /https:\/\/(?:console\.firebase\.google\.com|console\.cloud\.google\.com)\/[^\s)"']+/
  );
  return m ? m[0] : null;
}

/** 缺索引的錯誤長什麼樣：gRPC code 9，或訊息裡明講 requires an index。 */
function isMissingIndex(error) {
  if (!error) return false;
  if (error.code === 9 || error.code === 'failed-precondition') return true;
  return /requires an index|FAILED_PRECONDITION/i.test(String(error.message || ''));
}

/** 讀索引定義。讀不到不是致命錯誤，但要講清楚。 */
function loadDefinitions(file = INDEX_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const list = Array.isArray(raw.indexes) ? raw.indexes : [];
  return list.map((ix, i) => ({
    seq: i + 1,
    note: ix['//'] || '(無註解)',
    collectionGroup: ix.collectionGroup,
    fields: (ix.fields || []).filter((f) => f.fieldPath !== '__name__'),
  })).filter((d) => d.collectionGroup && d.fields.length >= 2);
}

/**
 * 依定義組出探測查詢。
 * @returns {{query: object, shape: string}}
 */
function buildProbe(db, def) {
  const fields = def.fields;
  const last = fields[fields.length - 1];
  const eqs = fields.slice(0, -1);

  let q = db.collection(def.collectionGroup);
  const parts = [];
  for (const f of eqs) {
    q = q.where(f.fieldPath, '==', PROBE_VALUE);
    parts.push(`${f.fieldPath}==?`);
  }
  const dir = String(last.order || 'ASCENDING') === 'DESCENDING' ? 'desc' : 'asc';
  q = q.orderBy(last.fieldPath, dir).limit(1);
  parts.push(`orderBy(${last.fieldPath} ${dir})`);

  return { query: q, shape: `${def.collectionGroup}: ${parts.join(' ')}` };
}

/**
 * 檢查全部索引。**永遠不丟例外**——這是啟動時的診斷，不該讓伺服器起不來。
 * @returns {Promise<{checked:number, missing:Array, failed:Array, enforced:boolean}>}
 */
async function checkIndexes(db, { file = INDEX_FILE, log = console } = {}) {
  const enforced = !process.env.FIRESTORE_EMULATOR_HOST;

  let defs;
  try {
    defs = loadDefinitions(file);
  } catch (error) {
    log.warn(`⚠️  讀不到索引定義（${file}）：${error.message}`);
    return { checked: 0, missing: [], failed: [], enforced };
  }
  if (!defs.length) {
    log.warn('⚠️  索引定義是空的，沒有東西可檢查');
    return { checked: 0, missing: [], failed: [], enforced };
  }

  const results = await Promise.all(defs.map(async (def) => {
    let probe;
    try {
      probe = buildProbe(db, def);
    } catch (error) {
      // 組不出查詢代表定義本身有問題（欄位名不合法之類）
      return { def, state: 'bad_definition', detail: error.message };
    }
    try {
      await probe.query.get();
      return { def, state: 'ok', shape: probe.shape };
    } catch (error) {
      if (isMissingIndex(error)) {
        return {
          def, state: 'missing', shape: probe.shape,
          url: extractIndexUrl(error.message),
          detail: String(error.message || '').split('\n')[0],
        };
      }
      return { def, state: 'error', shape: probe.shape, detail: error.message };
    }
  }));

  const missing = results.filter((r) => r.state === 'missing');
  const failed = results.filter((r) => r.state === 'error' || r.state === 'bad_definition');

  report({ results, missing, failed, enforced, log });
  return { checked: results.length, missing, failed, enforced };
}

function report({ results, missing, failed, enforced, log }) {
  const line = '─'.repeat(64);

  if (!enforced) {
    log.log(`🔍 索引檢查：${results.length} 個定義的查詢形狀都成立`);
    log.log('   ⚠️  本機 emulator 不強制複合索引，所以這裡的通過**不代表**'
      + '正式專案也有索引。要真正驗證請對正式專案跑一次。');
    if (failed.length) {
      log.log(`   另有 ${failed.length} 個定義有問題：`);
      failed.forEach((f) => log.log(`     · ${f.def.note}　${f.detail}`));
    }
    return;
  }

  if (!missing.length && !failed.length) {
    log.log(`✅ 索引檢查：${results.length} 個複合索引都已建立`);
    return;
  }

  if (missing.length) {
    log.error('\n' + line);
    log.error(`❌ 有 ${missing.length} 個複合索引還沒建立（共檢查 ${results.length} 個）`);
    log.error('   以下連結由 Firestore 回傳，點開就會帶著正確的欄位設定：');
    missing.forEach((m, i) => {
      log.error('');
      log.error(`   ${i + 1}. ${m.def.note}`);
      log.error(`      查詢形狀：${m.shape}`);
      log.error(`      建立連結：${m.url || '（錯誤訊息裡沒有連結）'}`);
      if (!m.url) log.error(`      原始錯誤：${m.detail}`);
    });
    log.error('');
    log.error('   也可以一次全部部署：firebase deploy --only firestore:indexes');
    log.error('   索引建立需要幾分鐘，建立中的查詢仍會失敗。');
    log.error(line + '\n');
  }

  if (failed.length) {
    log.error(`⚠️  另有 ${failed.length} 個索引無法確認（權限或連線問題）：`);
    failed.forEach((f) => log.error(`     · ${f.def.note}　${f.detail}`));
  }
}

/** 啟動時呼叫的包裝：吃掉所有例外，並尊重 INDEX_CHECK=off。 */
async function checkIndexesOnStartup(db, opts = {}) {
  const flag = String(process.env.INDEX_CHECK || '').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(flag)) {
    console.log('🔍 索引檢查：已由 INDEX_CHECK=off 關閉');
    return null;
  }
  try {
    return await checkIndexes(db, opts);
  } catch (error) {
    console.error('⚠️  索引檢查本身出錯（不影響伺服器運行）:', error.message);
    return null;
  }
}

module.exports = {
  PROBE_VALUE,
  extractIndexUrl,
  isMissingIndex,
  loadDefinitions,
  buildProbe,
  checkIndexes,
  checkIndexesOnStartup,
};
