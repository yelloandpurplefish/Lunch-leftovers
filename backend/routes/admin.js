/**
 * 管理員 / 開發者專區：手動維護班級與帳號。
 * 全部端點僅 admin 可用（requireRole 內 admin 一律通行）。
 */
const express = require('express');
const router = express.Router();
const {
  getOverview, listClasses, createClass, updateClass,
  setLunchLeader, setTeacher, listUsers, createUser, updateUser,
} = require('../controllers/adminController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const adminOnly = requireRole(ROLES.ADMIN);

router.get('/overview', authenticate, adminOnly, getOverview);

// 班級
router.get('/classes', authenticate, adminOnly, listClasses);
router.post('/classes', authenticate, adminOnly, createClass);
router.patch('/classes/:classId', authenticate, adminOnly, updateClass);
router.post('/classes/:classId/lunch-leader', authenticate, adminOnly, setLunchLeader);
router.post('/classes/:classId/teacher', authenticate, adminOnly, setTeacher);

// 帳號
router.get('/users', authenticate, adminOnly, listUsers);
router.post('/users', authenticate, adminOnly, createUser);
router.patch('/users/:userId', authenticate, adminOnly, updateUser);

module.exports = router;
