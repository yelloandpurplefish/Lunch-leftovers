/**
 * 跨班支援（每班每菜品剩餘量）。
 * 本班不足時才會回傳其他班的資料，門檻見 config/schema.js 的 SUPPORT。
 */
const express = require('express');
const router = express.Router();
const { getDishStatus, getDishAcrossClasses } = require('../controllers/supportController');
const { authenticate, requireClass } = require('../middleware/auth');

router.get('/dishes', authenticate, requireClass, getDishStatus);
router.get('/dish/:dishId', authenticate, requireClass, getDishAcrossClasses);

module.exports = router;
