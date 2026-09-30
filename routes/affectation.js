const express = require('express');
const router = express.Router();
const affectationController = require('../controllers/affectation');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');

router.post('/', auth, requireAdmin, affectationController.ajouter);
router.get('/', auth, affectationController.getAll);
router.get('/mes-affectations', auth, affectationController.mesAffectations);
router.get('/:id', auth, affectationController.getById);
router.put('/:id', auth, requireAdmin, affectationController.modifier);
router.patch('/:id/principal', auth, requireAdmin, affectationController.definirPrincipal);
router.patch('/:id/retirer', auth, requireAdmin, affectationController.retirer);
router.post('/:id/remplacer', auth, requireAdmin, affectationController.remplacer);
router.delete('/:id', auth, requireAdmin, affectationController.supprimer);

module.exports = router;
