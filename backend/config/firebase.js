const admin = require('firebase-admin');

// 檢查是否有 service account key
let serviceAccount;
try {
  // 優先使用環境變數中的 service account key
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    console.log('Using Firebase Service Account Key from environment variable');
  } else {
    // 嘗試從文件加載
    serviceAccount = require('../service-account-key.json');
    console.log('Using Firebase Service Account Key from file');
  }
} catch (error) {
  console.warn('Firebase Service Account Key not found. Firebase Admin SDK will not be initialized.');
  console.warn('For deployment, set FIREBASE_SERVICE_ACCOUNT_KEY environment variable.');
  console.warn('For local development, place service-account-key.json in the backend directory.');
  module.exports = { admin: null, db: null, auth: null };
  return;
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
