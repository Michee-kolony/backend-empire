const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat');
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/auth');
const { uploadFichiers } = require('../middleware/upload');

// Photos jointes aux messages, stockées dans le bucket : chat/photos
const uploadChat = uploadFichiers('chat', [{ name: 'photos', maxCount: 5 }]);

// Supervision : le super admin lit toutes les conversations, messages modifiés et supprimés compris
router.get('/supervision/conversations', auth, requireSuperAdmin, chatController.supervisionConversations);
router.get('/supervision/messages', auth, requireSuperAdmin, chatController.supervisionMessages);

// Gardien, propriétaire ou admin
router.get('/contacts', auth, chatController.contacts);
router.get('/conversations', auth, chatController.mesConversations);
router.post('/conversations', auth, chatController.ouvrir);
router.get('/conversations/:id', auth, chatController.getConversation);
router.get('/conversations/:id/messages', auth, chatController.getMessages);
router.post('/conversations/:id/messages', auth, uploadChat, chatController.envoyer);
router.post('/conversations/:id/lu', auth, chatController.marquerLu);

// Correction / suppression d'un message mal envoyé (auteur, dans le délai)
router.patch('/messages/:id', auth, chatController.modifier);
router.delete('/messages/:id', auth, chatController.supprimer);

module.exports = router;
