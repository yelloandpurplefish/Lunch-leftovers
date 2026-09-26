const express = require('express');
const router = express.Router();
const { getProfile, updateProfile, updateLastLogin } = require('../controllers/userController');
// 家長簽到已移到 parentController（每日一次 + 發幣給學生）；保留舊路徑相容前端
const { parentSignIn } = require('../controllers/parentController');
const { verifyFirebaseToken } = require('../middleware/auth');

router.get('/profile', verifyFirebaseToken, getProfile);
router.put('/profile', verifyFirebaseToken, updateProfile);
router.put('/last-login', verifyFirebaseToken, updateLastLogin);
router.post('/parent-sign-in', verifyFirebaseToken, parentSignIn);

module.exports = router;
