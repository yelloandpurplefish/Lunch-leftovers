const express = require('express');
const router = express.Router();
/**
 * 註：原本的「光盤行動自行領獎」與「剩食獎勵（自填克數）」已移除 ——
 * 吃完一餐改由教師在 /api/meal-check 勾選後發幣，剩食克數改由 /api/record 影像紀錄產生。
 */
const { submitSurvey, getPendingTasks, verifyTask } = require('../controllers/taskController');
const { verifyFirebaseToken, verifyTeacherOrAdmin } = require('../middleware/auth');

router.post('/submit-survey', verifyFirebaseToken, submitSurvey);
router.get('/pending', verifyFirebaseToken, verifyTeacherOrAdmin, getPendingTasks);
router.post('/verify', verifyFirebaseToken, verifyTeacherOrAdmin, verifyTask);

module.exports = router;
