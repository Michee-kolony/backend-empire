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

module.exports = auth;
module.exports.JWT_SECRET = JWT_SECRET;
