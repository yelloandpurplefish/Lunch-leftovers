const express = require('express');
const router = express.Router();
const { completeLightDisc, claimLeftoverReward, submitSurvey, getSupportClasses, completeSupport, getPendingTasks, verifyTask } = require('../controllers/taskController');
const { verifyFirebaseToken, verifyTeacherOrAdmin } = require('../middleware/auth');

router.post('/complete-light-disc', verifyFirebaseToken, completeLightDisc);
router.post('/claim-leftover-reward', verifyFirebaseToken, claimLeftoverReward);
router.post('/submit-survey', verifyFirebaseToken, submitSurvey);
router.get('/support/list', verifyFirebaseToken, getSupportClasses);
router.post('/support/complete', verifyFirebaseToken, completeSupport);
router.get('/pending', verifyFirebaseToken, verifyTeacherOrAdmin, getPendingTasks);
router.post('/verify', verifyFirebaseToken, verifyTeacherOrAdmin, verifyTask);

module.exports = router;
