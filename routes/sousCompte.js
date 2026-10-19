const express = require('express');
const router = express.Router();
const sousCompteController = require('../controllers/sousCompte');
const auth = require('../middleware/auth');

// Les sous-comptes sont créés et supprimés automatiquement avec les logements de la propriété
// (champ "nombreLogements"), il n'y a donc pas de route de création ni de suppression.
// Lecture : propriétaire et admin ; modification : propriétaire uniquement.
router.get('/', auth, sousCompteController.getAll);
router.get('/:id', auth, sousCompteController.getById);
router.put('/:id', auth, sousCompteController.modifier);
router.post('/:id/liberer', auth, sousCompteController.liberer);

module.exports = router;
