const express = require('express');
const router = express.Router();
const locataireController = require('../controllers/locataire');
const auth = require('../middleware/auth');
const { requireLocataire } = require('../middleware/auth');

// Les comptes locataires sont créés par le propriétaire depuis le logement (PUT /api/sous-comptes/:id)
router.post('/login', locataireController.login);
router.get('/moi', auth, requireLocataire, locataireController.moi);
router.put('/moi/password', auth, requireLocataire, locataireController.changerMotDePasse);

module.exports = router;
