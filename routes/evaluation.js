const express = require('express');
const router = express.Router();
const evaluationController = require('../controllers/evaluation');
const auth = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/auth');

// Rédaction (propriétaire ou gardien) : créer ou mettre à jour sa propre évaluation du mois
router.post('/', auth, evaluationController.enregistrer);

// Lecture par les intéressés (chacun voit aussi l'évaluation de l'autre)
router.get('/gardien', auth, evaluationController.gardien);
router.get('/proprietaire', auth, evaluationController.proprietaire);

// Entreprise (admin) : accès à toutes les évaluations
router.get('/', auth, requireAdmin, evaluationController.getAll);
router.delete('/:id', auth, requireSuperAdmin, evaluationController.supprimer);

module.exports = router;
