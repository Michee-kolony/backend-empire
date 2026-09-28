const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Administrateur = require('../models/admin');
const { JWT_SECRET } = require('../middleware/auth');

// Inscription d'un administrateur
exports.inscription = async (req, res) => {
    try {
        const { nom, email, password, role } = req.body;

        if (!nom || !email || !password) {
            return res.status(400).json({ success: false, message: 'Nom, email et mot de passe sont obligatoires' });
        }

        const existe = await Administrateur.findOne({ email: email.toLowerCase().trim() });
        if (existe) {
            return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
        }

        const hash = await bcrypt.hash(password, 10);

        const admin = await Administrateur.create({ nom, email, password: hash, role });

        const data = admin.toObject();
        delete data.password;

        res.status(201).json({ success: true, message: 'Administrateur créé avec succès', admin: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Connexion d'un administrateur : renvoie le token et toutes ses données
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email et mot de passe sont obligatoires' });
        }

        const admin = await Administrateur.findOne({ email: email.toLowerCase().trim() });
        if (!admin) {
            return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
        }

        const valide = await bcrypt.compare(password, admin.password);
        if (!valide) {
            return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
        }

        if (!admin.actif) {
            return res.status(403).json({ success: false, message: 'Ce compte est désactivé' });
        }

        const token = jwt.sign(
            { id: admin._id, role: admin.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const data = admin.toObject();
        delete data.password;

        res.status(200).json({ success: true, message: 'Connexion réussie', token, admin: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer un administrateur par son id
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const admin = await Administrateur.findById(id).select('-password');
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Administrateur introuvable' });
        }

        res.status(200).json({ success: true, admin });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer tous les administrateurs
exports.getAll = async (req, res) => {
    try {
        const admins = await Administrateur.find().select('-password').sort({ createdAt: -1 });

        res.status(200).json({ success: true, total: admins.length, admins });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Supprimer un administrateur
exports.supprimer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const admin = await Administrateur.findByIdAndDelete(id);
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Administrateur introuvable' });
        }

        res.status(200).json({ success: true, message: 'Administrateur supprimé avec succès' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
