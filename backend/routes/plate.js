/** 學生的個人餐盤辨識（午餐長也是學生，一樣能用）。 */
const express = require('express');
const router = express.Router();
const { getTodayScan, scanPlate } = require('../controllers/plateController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const studentOnly = requireRole(ROLES.STUDENT);

router.get('/today', authenticate, studentOnly, getTodayScan);
router.post('/scan', authenticate, studentOnly, scanPlate);

module.exports = router;
