const express = require('express');
const router = express.Router();
const { redeemItem, getExchangeItems, getExchangeHistory } = require('../controllers/exchangeController');
const { verifyFirebaseToken } = require('../middleware/auth');
const { requireShopOpen } = require('../lib/shop');

// 兌換要過商城閘門；商品清單與個人紀錄不擋——
// 關閉期間學生仍該看得到獎品與自己換過什麼，只是換不了。
router.post('/redeem', verifyFirebaseToken, requireShopOpen, redeemItem);
router.get('/items', verifyFirebaseToken, getExchangeItems);
router.get('/history', verifyFirebaseToken, getExchangeHistory);

module.exports = router;
