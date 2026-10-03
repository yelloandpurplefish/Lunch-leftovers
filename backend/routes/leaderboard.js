const express = require('express');
const router = express.Router();
const { getLeaderboard, getHeroBoard } = require('../controllers/leaderboardController');
const { verifyFirebaseToken } = require('../middleware/auth');

// 個人英雄榜：E 幣 / S 幣 / 種樹數一次看完
router.get('/heroes', verifyFirebaseToken, getHeroBoard);
router.get('/', verifyFirebaseToken, getLeaderboard);

module.exports = router;
