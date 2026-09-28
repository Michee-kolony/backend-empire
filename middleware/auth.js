const jwt = require('jsonwebtoken');

const JWT_SECRET = 'empire_jardinage_cle_secrete_2026';

// Vérifie le token envoyé dans l'en-tête : Authorization: Bearer <token>
const auth = (req, res, next) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Token manquant' });
    }

    try {
        const token = header.split(' ')[1];
        req.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
    }
};

// À utiliser après `auth` : bloque l'accès si le compte connecté n'est pas
// SUPER_ADMIN (ex. suppression d'un administrateur).
const requireSuperAdmin = (req, res, next) => {
    if (!req.admin || req.admin.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ success: false, message: 'Action réservée aux super administrateurs' });
    }
    next();
};

module.exports = auth;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.requireSuperAdmin = requireSuperAdmin;
