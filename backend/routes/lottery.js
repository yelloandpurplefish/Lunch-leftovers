const express = require('express');
const router = express.Router();
const { spinLottery, getLotteryHistory } = require('../controllers/lotteryController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/spin', verifyFirebaseToken, spinLottery);
router.get('/history', verifyFirebaseToken, getLotteryHistory);

module.exports = router;
