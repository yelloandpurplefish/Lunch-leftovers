const express = require('express');
const router = express.Router();
const { completeLightDisc, claimLeftoverReward, submitSurvey } = require('../controllers/taskController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/complete-light-disc', verifyFirebaseToken, completeLightDisc);
router.post('/claim-leftover-reward', verifyFirebaseToken, claimLeftoverReward);
router.post('/submit-survey', verifyFirebaseToken, submitSurvey);

module.exports = router;
