const express = require('express');
const router = express.Router();
const { completeLightDisc, claimLeftoverReward, submitSurvey, getSupportClasses, completeSupport } = require('../controllers/taskController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/complete-light-disc', verifyFirebaseToken, completeLightDisc);
router.post('/claim-leftover-reward', verifyFirebaseToken, claimLeftoverReward);
router.post('/submit-survey', verifyFirebaseToken, submitSurvey);
router.get('/support/list', verifyFirebaseToken, getSupportClasses);
router.post('/support/complete', verifyFirebaseToken, completeSupport);

module.exports = router;
