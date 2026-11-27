/**
 * 管理員專區：任何班級、任何角色都能操作。
 * 全部端點僅 admin 可用（requireRole 內 admin 一律通行）。
 *
 *   班級與帳號        controllers/adminRosterController.js
 *   參數、同步、商城、皮重  controllers/adminController.js
 *   資料檢查          lib/consistency.js
 *   稱重（任何班、手動輸入、重設）走 /api/record?classId=…，餐盤更正走這裡的 /users/:id/plates
 */
const express = require('express');
const router = express.Router();
const roster = require('../controllers/adminRosterController');
const {
  getCoinRules, updateCoinRules,
  syncStudents, syncMenus,
  getShop, updateShop,
  getBucketTare, measureBucketTare, updateBucketTare,
} = require('../controllers/adminController');
const consistency = require('../lib/consistency');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const adminOnly = [authenticate, requireRole(ROLES.ADMIN)];

// 總覽
router.get('/overview', ...adminOnly, roster.getOverview);

// 班級
router.get('/classes', ...adminOnly, roster.listClasses);
router.post('/classes', ...adminOnly, roster.createClass);
router.get('/classes/:classId', ...adminOnly, roster.getClassDetail);
router.patch('/classes/:classId', ...adminOnly, roster.updateClass);
router.delete('/classes/:classId', ...adminOnly, roster.deleteClass);
router.post('/classes/:classId/teacher', ...adminOnly, roster.setTeacher);
router.delete('/classes/:classId/teacher', ...adminOnly, roster.clearTeacher);
router.post('/classes/:classId/lunch-leader', ...adminOnly, roster.setLunchLeader);
router.delete('/classes/:classId/lunch-leader', ...adminOnly, roster.clearLunchLeader);

// 帳號
router.get('/users', ...adminOnly, roster.listUsers);
router.post('/users', ...adminOnly, roster.createUser);
router.get('/users/:userId', ...adminOnly, roster.getUserDetail);
router.patch('/users/:userId', ...adminOnly, roster.updateUser);
router.delete('/users/:userId', ...adminOnly, roster.deleteUser);
router.post('/users/:userId/coins', ...adminOnly, roster.adjustCoins);
router.put('/users/:userId/plates/:date', ...adminOnly, roster.setPlate);
router.delete('/users/:userId/plates/:date', ...adminOnly, roster.clearPlate);
router.put('/users/:userId/binding', ...adminOnly, roster.setBinding);
router.delete('/users/:userId/binding', ...adminOnly, roster.clearBinding);

// 可調參數、同步、商城、皮重
router.get('/coin-rules', ...adminOnly, getCoinRules);
router.put('/coin-rules', ...adminOnly, updateCoinRules);
router.post('/sync/students', ...adminOnly, syncStudents);
router.post('/sync/menus', ...adminOnly, syncMenus);
router.get('/shop', ...adminOnly, getShop);
router.put('/shop', ...adminOnly, updateShop);
router.get('/bucket-tare', ...adminOnly, getBucketTare);
router.post('/bucket-tare/measure', ...adminOnly, measureBucketTare);
router.put('/bucket-tare', ...adminOnly, updateBucketTare);

// 資料檢查
const wrap = (fn) => async (req, res) => {
  try {
    return res.status(200).json({ success: true, ...(await fn(req)) });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ success: false, message: error.message });
    console.error('資料檢查失敗:', error);
    return res.status(500).json({ success: false, message: error.message || '資料檢查失敗' });
  }
};
router.get('/consistency', ...adminOnly, wrap(() => consistency.scan()));
router.post('/consistency/fix', ...adminOnly, wrap((req) => consistency.fix(String(req.body.type || ''))));
router.get('/consistency/balances', ...adminOnly, wrap((req) => consistency.checkBalances(String(req.query.classId || ''))));
router.post('/consistency/balances/fix', ...adminOnly, wrap((req) => consistency.fixBalances(String(req.body.classId || ''), req.user.uid)));

module.exports = router;
