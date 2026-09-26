/** 家長：每日簽到（+1S 給綁定學生）、查看孩子午餐狀況。 */
const express = require('express');
const router = express.Router();
const { parentSignIn, getChildStatus } = require('../controllers/parentController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const parentOnly = requireRole(ROLES.PARENT);

router.post('/sign-in', authenticate, parentOnly, parentSignIn);
router.get('/child-status', authenticate, parentOnly, getChildStatus);

module.exports = router;
