const express = require('express');
const router = express.Router();
/**
 * 只剩每日菜色問卷（不發幣）。
 * ESG 幣看學生拍的餐盤結果（/api/plate）；全班剩食量由午餐長在 /api/record 稱重紀錄。
 */
const { submitSurvey } = require('../controllers/taskController');
const { authenticate } = require('../middleware/auth');

router.post('/submit-survey', authenticate, submitSurvey);

module.exports = router;
