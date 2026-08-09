const express = require('express');
const router = express.Router();
const { testFirebase, createTestUser } = require('../controllers/debugController');

// 測試 Firebase 連接
router.get('/firebase', testFirebase);

// 創建測試用戶（僅限開發環境）
router.post('/create-test-user', createTestUser);

module.exports = router;