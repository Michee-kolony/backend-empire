const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin');
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/auth');

router.post('/inscription', adminController.inscription);
router.post('/login', adminController.login);
router.get('/', auth, adminController.getAll);
router.get('/:id', auth, adminController.getById);
router.delete('/:id', auth, requireSuperAdmin, adminController.supprimer);

module.exports = router;
