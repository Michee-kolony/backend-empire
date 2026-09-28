const express = require('express');
const router = express.Router();
const proprietaireController = require('../controllers/proprietaire');
const auth = require('../middleware/auth');
const { uploadPhoto } = require('../middleware/upload');

router.post('/inscription', uploadPhoto('proprietaire', 'photo'), proprietaireController.inscription);
router.post('/login', proprietaireController.login);
router.get('/', auth, proprietaireController.getAll);
router.get('/:id', auth, proprietaireController.getById);
router.put('/:id', auth, uploadPhoto('proprietaire', 'photo'), proprietaireController.modifier);
router.delete('/:id', auth, proprietaireController.supprimer);

module.exports = router;
