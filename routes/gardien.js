const express = require('express');
const router = express.Router();
const gardienController = require('../controllers/gardien');
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/auth');
const { uploadPhoto } = require('../middleware/upload');

router.post('/inscription', auth, uploadPhoto('photo-gardien', 'photoProfil'), gardienController.inscription);
router.post('/login', gardienController.login);
router.patch('/position', auth, gardienController.mettreAJourPosition);
router.get('/', auth, gardienController.getAll);
router.get('/:id', auth, gardienController.getById);
router.put('/:id', auth, requireSuperAdmin, uploadPhoto('photo-gardien', 'photoProfil'), gardienController.modifier);
router.patch('/:id/statut', auth, gardienController.changerStatut);
router.post('/:id/commentaires', auth, uploadPhoto('photo-proprietaire', 'photoProprietaire'), gardienController.ajouterCommentaire);
router.delete('/:id', auth, requireSuperAdmin, gardienController.supprimer);

module.exports = router;
