const express = require('express');
const router = express.Router();
/**
 * 只剩每日菜色問卷（不發幣）。
 * 吃完一餐由教師在 /api/meal-check 勾選後發幣；剩食量由午餐長在 /api/record 稱重紀錄。
 */
const { submitSurvey } = require('../controllers/taskController');
const { authenticate } = require('../middleware/auth');

router.post('/submit-survey', authenticate, submitSurvey);

module.exports = router;
