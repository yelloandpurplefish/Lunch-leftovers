const express = require('express');
const router = express.Router();
const { register, login, logout, verifyStudent } = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
// 家長註冊前先驗證孩子資料（友善驗證按鈕用；不建立任何資料）
router.post('/verify-student', verifyStudent);
router.post('/logout', logout);

module.exports = router;
