const express = require('express');
const router = express.Router();
const { spinLottery, getLotteryHistory, getLatestGrandPrize } = require('../controllers/lotteryController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/spin', verifyFirebaseToken, spinLottery);
router.get('/history', verifyFirebaseToken, getLotteryHistory);
router.get('/announcement', verifyFirebaseToken, getLatestGrandPrize);

module.exports = router;
