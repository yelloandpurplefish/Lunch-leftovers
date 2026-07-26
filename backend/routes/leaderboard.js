const express = require('express');
const router = express.Router();
const { getLeaderboard } = require('../controllers/leaderboardController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.get('/', verifyFirebaseToken, getLeaderboard);

module.exports = router;
