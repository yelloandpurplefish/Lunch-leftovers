/**
 * Firestore 連線。三種模式，依環境變數決定：
 *
 *  A) 本機 Emulator：設 FIRESTORE_EMULATOR_HOST（例 127.0.0.1:8080）→ 不需任何金鑰。
 *     這是本機開發與自動化測試唯一不用真專案的方式（原版缺這條，沒金鑰就直接掛掉）。
 *  B) 環境變數金鑰：FIREBASE_SERVICE_ACCOUNT_KEY 或 FIREBASE_SERVICE_ACCOUNT
 *     （可貼整份 JSON，或貼 base64 —— 有些平台不接受含換行的值）。
 *  C) 檔案金鑰：backend/service-account-key.json。
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT_ID ||
  'lunch-leftovers-dev';

function parseServiceAccount(raw) {
  const text = String(raw).trim();
  const json = text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8');
  return JSON.parse(json);
}

function loadServiceAccount() {
  const envKey =
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (envKey) {
    try {
      return { account: parseServiceAccount(envKey), from: '環境變數' };
    } catch (error) {
      console.error('❌ 服務帳戶金鑰格式錯誤（環境變數）:', error.message);
      return null;
    }
  }
  const filePath = path.join(__dirname, '..', 'service-account-key.json');
  if (fs.existsSync(filePath)) {
    try {
      return { account: JSON.parse(fs.readFileSync(filePath, 'utf8')), from: '檔案' };
    } catch (error) {
      console.error('❌ 服務帳戶金鑰格式錯誤（檔案）:', error.message);
    }
  }
  return null;
}

function init() {
  if (admin.apps.length) return admin.app();

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: PROJECT_ID });
    console.log(
      `🧪 連線 Firestore Emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}（專案 ${PROJECT_ID}）`
    );
    return admin.app();
  }

  const loaded = loadServiceAccount();
  if (!loaded) {
    console.error(
      '❌ 找不到 Firestore 連線方式。請任選其一：\n' +
        '   · 本機開發：設 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 並啟動 firebase emulators\n' +
        '   · 雲端部署：設 FIREBASE_SERVICE_ACCOUNT_KEY（服務帳戶 JSON 或其 base64）\n' +
        '   · 本機真專案：放 backend/service-account-key.json'
    );
    return null;
  }

  admin.initializeApp({
    credential: admin.credential.cert(loaded.account),
    projectId: loaded.account.project_id || PROJECT_ID,
  });
  console.log(
    `🔐 連線正式 Firestore（專案 ${loaded.account.project_id || PROJECT_ID}，金鑰來自${loaded.from}）`
  );
  return admin.app();
}

const app = init();

if (!app) {
  module.exports = { admin: null, db: null, auth: null, ready: false };
} else {
  const db = admin.firestore();
  // 寫入時忽略 undefined 欄位，否則選填欄位（如未綁定家長）會讓整筆寫入失敗
  db.settings({ ignoreUndefinedProperties: true });
  module.exports = { admin, db, auth: admin.auth(), ready: true };
}
