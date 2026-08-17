const express = require('express');
const router = express.Router();
const { getProfile, updateProfile, updateLastLogin, parentSignIn } = require('../controllers/userController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.get('/profile', verifyFirebaseToken, getProfile);
router.put('/profile', verifyFirebaseToken, updateProfile);
router.put('/last-login', verifyFirebaseToken, updateLastLogin);
router.post('/parent-sign-in', verifyFirebaseToken, parentSignIn);

module.exports = router;
