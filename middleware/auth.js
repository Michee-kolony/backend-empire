const jwt = require('jsonwebtoken');

const JWT_SECRET = 'empire_jardinage_cle_secrete_2026';

// Un locataire (token { compte: 'Locataire' }) n'a accès qu'à son espace et au chat :
// sans ce verrou, son rôle LOCATAIRE serait pris pour un compte propriétaire par les autres routes.
const ROUTES_LOCATAIRE = ['/api/locataires', '/api/chat'];
const estLocataire = (jeton) => jeton?.compte === 'Locataire';

// Vérifie le token envoyé dans l'en-tête : Authorization: Bearer <token>
const auth = (req, res, next) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Token manquant' });
    }

    try {
        const token = header.split(' ')[1];
        req.admin = jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
    }

    if (estLocataire(req.admin) && !ROUTES_LOCATAIRE.includes(req.baseUrl)) {
        return res.status(403).json({ success: false, message: 'Accès réservé aux propriétaires' });
    }
    next();
};

// À utiliser après `auth` : réservé aux locataires connectés
const requireLocataire = (req, res, next) => {
    if (!estLocataire(req.admin)) {
        return res.status(403).json({ success: false, message: 'Réservé aux locataires' });
    }
    next();
};

// À utiliser après `auth` : bloque l'accès si le compte connecté n'est pas
// SUPER_ADMIN (ex. suppression d'un administrateur).
const requireSuperAdmin = (req, res, next) => {
    if (!req.admin || req.admin.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, message: 'Action réservée aux super administrateurs' });
    }
    next();
};

// À utiliser après `auth` : réservé aux administrateurs (ADMIN ou SUPER_ADMIN)
const requireAdmin = (req, res, next) => {
    if (!req.admin || !['ADMIN', 'SUPER_ADMIN'].includes(req.admin.role)) {
        return res.status(403).json({ success: false, message: 'Action réservée aux administrateurs' });
    }
    next();
};

module.exports = auth;
module.exports.requireAdmin = requireAdmin;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.requireSuperAdmin = requireSuperAdmin;
module.exports.requireLocataire = requireLocataire;
module.exports.estLocataire = estLocataire;
