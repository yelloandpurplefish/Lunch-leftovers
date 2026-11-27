const express = require('express');
const router = express.Router();
const { redeemItem, getExchangeItems, getExchangeHistory } = require('../controllers/exchangeController');
const { authenticate } = require('../middleware/auth');
const { requireShopOpen } = require('../lib/shop');

// 兌換時才檢查商城是否開放；商品清單與紀錄在關閉期間仍可查看
router.post('/redeem', authenticate, requireShopOpen, redeemItem);
router.get('/items', authenticate, getExchangeItems);
router.get('/history', authenticate, getExchangeHistory);

module.exports = router;
