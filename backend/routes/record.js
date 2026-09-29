/**
 * 剩食紀錄（四桶辨識）路由。
 * 讀取：班上任何人都可看（學生端唯讀）；寫入：僅午餐長（含導師/管理員）。
 */
const express = require('express');
const router = express.Router();
const {
  getTodaySession, startSession, measureBucket, adjustBucket,
  finalizeSession, getRecordHistory, getVisionStatus,
} = require('../controllers/recordController');
const { authenticate, requireRole, requireClass } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const canRecord = requireRole(ROLES.LUNCH_LEADER, ROLES.TEACHER);

// 唯讀
router.get('/vision-status', authenticate, getVisionStatus);
router.get('/today', authenticate, requireClass, getTodaySession);
router.get('/history', authenticate, requireClass, getRecordHistory);

// 紀錄（午餐長專屬）
router.post('/start', authenticate, canRecord, requireClass, startSession);
router.post('/bucket/:bucketId/measure', authenticate, canRecord, requireClass, measureBucket);
router.patch('/bucket/:bucketId', authenticate, canRecord, requireClass, adjustBucket);
router.post('/finalize', authenticate, canRecord, requireClass, finalizeSession);

module.exports = router;
