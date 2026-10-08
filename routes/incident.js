const express = require('express');
const router = express.Router();
const incidentController = require('../controllers/incident');
const auth = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { uploadFichiers } = require('../middleware/upload');

// Fichiers stockés dans le bucket : incident/photos, incident/videos
// (5 × 20 Mo + 2 × 30 Mo : reste sous client_max_body_size de nginx)
const uploadIncident = uploadFichiers('incident', [
    { name: 'photos', maxCount: 5 },
    { name: 'videos', maxCount: 2, videos: true }
]);

router.get('/options', auth, incidentController.options);

// Gardien, propriétaire ou admin
router.post('/', auth, uploadIncident, incidentController.signaler);
router.get('/mes-incidents', auth, incidentController.mesIncidents);

// Entreprise (admin)
router.get('/', auth, requireAdmin, incidentController.getAll);
router.get('/:id', auth, incidentController.getById);
// Admin, ou propriétaire pour les incidents de ses propriétés (contrôle dans le contrôleur)
router.patch('/:id', auth, incidentController.traiter);
router.delete('/:id', auth, requireSuperAdmin, incidentController.supprimer);

module.exports = router;
