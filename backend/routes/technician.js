/**
 * 技術員專區：稱重模組佈建與維護。
 * 技術員只管硬體，碰不到學生資料與幣（管理員一律通行）。
 */
const express = require('express');
const router = express.Router();
const {
  listDevices, registerDevices, updateDevice, setTare,
  calibrate, rotateToken, listReadings, fleetHealth,
} = require('../controllers/technicianController');
const { authenticate, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/schema');

const techOnly = requireRole(ROLES.TECHNICIAN);

router.get('/devices', authenticate, techOnly, listDevices);
router.post('/devices', authenticate, techOnly, registerDevices);
router.patch('/devices/:deviceId', authenticate, techOnly, updateDevice);
router.post('/devices/:deviceId/tare', authenticate, techOnly, setTare);
router.post('/devices/:deviceId/calibrate', authenticate, techOnly, calibrate);
router.post('/devices/:deviceId/rotate-token', authenticate, techOnly, rotateToken);
router.get('/devices/:deviceId/readings', authenticate, techOnly, listReadings);
router.get('/health', authenticate, techOnly, fleetHealth);

module.exports = router;
