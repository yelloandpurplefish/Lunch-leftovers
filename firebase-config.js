// Backend API URL - 自動檢測環境
const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

// 全局變數
let currentUser = null;
let idToken = null;
// ESG 幣（唯一的幣別）
let esgCoin = 0;
