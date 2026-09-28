const express = require('express');
const router = express.Router();
const proprieteController = require('../controllers/propriete');
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/auth');
const { uploadFichiers } = require('../middleware/upload');

// Fichiers stockés dans le bucket : propriete/photos, propriete/documentPropriete, propriete/autresDocuments
const uploadPropriete = uploadFichiers('propriete', [
    { name: 'photos', maxCount: 5 },
    { name: 'documentPropriete', maxCount: 1, documents: true },
    { name: 'autresDocuments', maxCount: 5, documents: true }
]);

router.post('/', auth, uploadPropriete, proprieteController.ajouter);
router.get('/', auth, proprieteController.getAll);
router.get('/:id', auth, proprieteController.getById);
router.put('/:id', auth, uploadPropriete, proprieteController.modifier);
router.delete('/:id', auth, requireSuperAdmin, proprieteController.supprimer);

module.exports = router;
