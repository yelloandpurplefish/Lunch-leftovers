/** 餐盤辨識：學生拍（午餐長也是學生）；老師看本班；管理員看任何班（更正在 /api/admin）。 */
const express = require('express');
const router = express.Router();
const { getTodayScan, scanPlate, getClassPlates } = require('../controllers/plateController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const studentOnly = requireRole(ROLES.STUDENT);
const teacherOnly = requireRole(ROLES.TEACHER);

router.get('/today', authenticate, studentOnly, getTodayScan);
router.post('/scan', authenticate, studentOnly, scanPlate);
router.get('/class', authenticate, teacherOnly, getClassPlates);

module.exports = router;
