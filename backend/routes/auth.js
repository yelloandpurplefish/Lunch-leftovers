const express = require('express');
const router = express.Router();
const { register, login, logout } = require('../controllers/authController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.post('/register', register);
router.post('/login', verifyFirebaseToken, login);
router.post('/logout', verifyFirebaseToken, logout);

module.exports = router;
