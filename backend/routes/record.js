/**
 * 全班剩食紀錄（依序稱重）路由。
 * 全部限本班午餐長、導師、管理員；非管理員只能操作自己的班（requireRecorder）。
 */
const express = require('express');
const router = express.Router();
const {
  getTodaySession, startSession, getWeighQueue, weighDish, finalizeSession,
} = require('../controllers/recordController');
const { authenticate, requireRecorder } = require('../middleware/auth');

router.get('/today', authenticate, requireRecorder, getTodaySession);
router.post('/start', authenticate, requireRecorder, startSession);
router.get('/weigh-queue', authenticate, requireRecorder, getWeighQueue);
router.post('/weigh', authenticate, requireRecorder, weighDish);
router.post('/finalize', authenticate, requireRecorder, finalizeSession);

module.exports = router;
