// Firebase Configuration
// 注意：本專案使用 compat 版 SDK（由 index.html 的 CDN script 載入），
// 因此不使用 Firebase Console 提供的 modular import 語法。
const firebaseConfig = {
  apiKey: "AIzaSyBjAAwTLolkSzozh2oaIWIR2oIgbFrTb2E",
  authDomain: "lunch-leftovers.firebaseapp.com",
  projectId: "lunch-leftovers",
  storageBucket: "lunch-leftovers.firebasestorage.app",
  messagingSenderId: "1040305573203",
  appId: "1:1040305573203:web:9426d79fbafceb3519a5a6",
  measurementId: "G-RPB0N5STC6"
};

// Initialize Firebase - 僅用於身份驗證，資料操作一律透過後端 API
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
