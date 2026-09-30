const express = require('express');
const router = express.Router();
const rapportController = require('../controllers/rapport');
const auth = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');

router.get('/objets', auth, rapportController.objets);

// Gardien (token GARDIEN)
router.post('/', auth, rapportController.ajouter);
router.get('/mes-rapports', auth, rapportController.mesRapports);

// Entreprise (admin)
router.get('/', auth, requireAdmin, rapportController.getAll);
router.get('/:id', auth, rapportController.getById);
router.patch('/:id/statut', auth, requireAdmin, rapportController.changerStatut);
router.delete('/:id', auth, requireSuperAdmin, rapportController.supprimer);

module.exports = router;
