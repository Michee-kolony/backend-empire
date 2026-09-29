const express = require('express');
const router = express.Router();
const paiementController = require('../controllers/paiement');
const auth = require('../middleware/auth');

router.post('/', auth, paiementController.ajouter);
router.get('/', auth, paiementController.getAll);
router.get('/:id', auth, paiementController.getById);
router.put('/:id', auth, paiementController.modifier);
router.delete('/:id', auth, paiementController.supprimer);

module.exports = router;