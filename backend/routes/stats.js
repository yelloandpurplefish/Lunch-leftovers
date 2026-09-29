/** 剩餘量變化曲線與菜色剩食排名。 */
const express = require('express');
const router = express.Router();
const { getLeftoverTrend, getDishRanking } = require('../controllers/statsController');
const { authenticate } = require('../middleware/auth');

router.get('/leftover-trend', authenticate, getLeftoverTrend);
router.get('/dish-ranking', authenticate, getDishRanking);

module.exports = router;
