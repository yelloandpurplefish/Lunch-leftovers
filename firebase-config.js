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
