// Firebase Configuration
// 請在 Firebase Console 建立專案後，將設定複製到這裡
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase - 僅用於身份驗證
firebase.initializeApp(firebaseConfig);

// Backend API URL - 自動檢測環境
const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

// 全局變數
let currentUser = null;
let idToken = null;
let eCoin = 0;
let sCoin = 0;
let score = 0;
