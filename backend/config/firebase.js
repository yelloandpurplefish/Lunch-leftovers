const admin = require('firebase-admin');

// 檢查是否有 service account key
let serviceAccount;
try {
  serviceAccount = require('../service-account-key.json');
} catch (error) {
  console.warn('service-account-key.json not found, Firebase Admin SDK will not be initialized');
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
