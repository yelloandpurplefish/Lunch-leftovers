const express = require('express');
const router = express.Router();
const { spinLottery, getLotteryHistory, getLatestGrandPrize } = require('../controllers/lotteryController');
const { authenticate } = require('../middleware/auth');

router.post('/spin', authenticate, spinLottery);
router.get('/history', authenticate, getLotteryHistory);
router.get('/announcement', authenticate, getLatestGrandPrize);

module.exports = router;
