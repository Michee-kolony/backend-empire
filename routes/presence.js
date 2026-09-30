const express = require('express');
const router = express.Router();
const presenceController = require('../controllers/presence');
const auth = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');

// Gardien (token GARDIEN)
router.post('/debut', auth, presenceController.commencer);
router.post('/fin', auth, presenceController.terminer);
router.get('/mon-service', auth, presenceController.monService);
router.get('/mes-services', auth, presenceController.mesServices);

// Entreprise (admin)
router.get('/', auth, requireAdmin, presenceController.getAll);
router.get('/absences', auth, requireAdmin, presenceController.absences);
router.get('/rapport', auth, requireAdmin, presenceController.rapport);
router.get('/:id', auth, presenceController.getById);
router.patch('/:id/cloturer', auth, requireAdmin, presenceController.cloturer);
router.delete('/:id', auth, requireSuperAdmin, presenceController.supprimer);

module.exports = router;
