/**
 * 教師每日逐生檢查「吃完他的部分」＝「吃完一餐」（發 +1E +1S）。
 * 名冊與勾選僅導師/管理員；/mine 供學生與家長查看。
 */
const express = require('express');
const router = express.Router();
const { getRoster, toggleCheck, finishAll, getMyChecks } = require('../controllers/mealCheckController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const teacherOnly = requireRole(ROLES.TEACHER);

router.get('/roster', authenticate, teacherOnly, getRoster);
router.post('/toggle', authenticate, teacherOnly, toggleCheck);
router.post('/finish-all', authenticate, teacherOnly, finishAll);

// 學生看自己、家長看綁定的孩子
router.get('/mine', authenticate, getMyChecks);

module.exports = router;
