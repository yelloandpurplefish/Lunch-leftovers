const express = require('express');
const router = express.Router();
const { getTodayMenu } = require('../controllers/menuController');
const { authenticate } = require('../middleware/auth');

// 唯讀。菜單本身不是機密，但建議攝取熱量是依個人體位算的，所以仍要登入。
router.get('/today', authenticate, getTodayMenu);

module.exports = router;
