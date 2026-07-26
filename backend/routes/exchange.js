const express = require('express');
const router = express.Router();
const { redeemItem, getExchangeItems, getExchangeHistory } = require('../controllers/exchangeController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/redeem', verifyFirebaseToken, redeemItem);
router.get('/items', verifyFirebaseToken, getExchangeItems);
router.get('/history', verifyFirebaseToken, getExchangeHistory);

module.exports = router;
