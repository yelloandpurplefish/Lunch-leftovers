const express = require('express');
const router = express.Router();
const { submitAnalysis, getAnalysisStats } = require('../controllers/analysisController');
const { verifyFirebaseToken, verifyAdmin } = require('../middleware/auth');

router.post('/submit', verifyFirebaseToken, submitAnalysis);
router.get('/stats', verifyFirebaseToken, verifyAdmin, getAnalysisStats);

module.exports = router;
