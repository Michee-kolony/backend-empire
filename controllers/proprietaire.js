const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Proprietaire = require('../models/proprietaire');
const { JWT_SECRET } = require('../middleware/auth');
const { supprimerDeR2 } = require('../middleware/upload');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Champs qu'un propriétaire peut modifier lui-même
const CHAMPS_MODIFIABLES = ['nom', 'postnom', 'prenom', 'sexe', 'profession', 'telephone', 'email', 'adresse'];

// Champs réservés aux administrateurs
const CHAMPS_ADMIN = ['role', 'actif'];

// Un email vide ne doit pas être enregistré (sinon conflit avec l'index unique)
const nettoyerEmail = (email) => (email && email.trim() ? email.toLowerCase().trim() : undefined);

// Vérifie que le compte connecté est un admin ou le propriétaire lui-même
const estAdminOuLuiMeme = (req, id) => ROLES_ADMIN.includes(req.admin.role) || String(req.admin.id) === String(id);

// Inscription d'un propriétaire (multipart/form-data, photo de profil facultative dans le champ "photo")
exports.inscription = async (req, res) => {
    // En cas d'échec, la photo déjà envoyée sur R2 est supprimée
    const annulerPhoto = () => req.photo && supprimerDeR2([req.photo]).catch(() => {});

    try {
        const { nom, postnom, prenom, sexe, profession, telephone, password, adresse } = req.body;
        const email = nettoyerEmail(req.body.email);

        if (!nom || !telephone || !password) {
            annulerPhoto();
            return res.status(400).json({ success: false, message: 'Nom, téléphone et mot de passe sont obligatoires' });
        }

        const existe = await Proprietaire.findOne({
            $or: [{ telephone: telephone.trim() }, ...(email ? [{ email }] : [])]
        });
        if (existe) {
            annulerPhoto();
            const champ = existe.telephone === telephone.trim() ? 'Ce téléphone' : 'Cet email';
            return res.status(409).json({ success: false, message: `${champ} est déjà utilisé` });
        }

        const hash = await bcrypt.hash(password, 10);

        const proprietaire = await Proprietaire.create({
            nom, postnom, prenom, sexe, profession, telephone, email, adresse,
            password: hash,
            photo: req.photo || null
        });

        const data = proprietaire.toObject();
        delete data.password;

        res.status(201).json({ success: true, message: 'Propriétaire créé avec succès', proprietaire: data });
    } catch (error) {
        annulerPhoto();
        if (error.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Connexion d'un propriétaire avec son téléphone ou son email : renvoie le token et toutes ses données
exports.login = async (req, res) => {
    try {
        const { identifiant, password } = req.body;

        if (!identifiant || !password) {
            return res.status(400).json({ success: false, message: 'Téléphone (ou email) et mot de passe sont obligatoires' });
        }

        const valeur = identifiant.trim();
        const proprietaire = await Proprietaire.findOne({
            $or: [{ telephone: valeur }, { email: valeur.toLowerCase() }]
        });
        if (!proprietaire) {
            return res.status(401).json({ success: false, message: 'Identifiant ou mot de passe incorrect' });
        }

        const valide = await bcrypt.compare(password, proprietaire.password);
        if (!valide) {
            return res.status(401).json({ success: false, message: 'Identifiant ou mot de passe incorrect' });
        }

        if (!proprietaire.actif) {
            return res.status(403).json({ success: false, message: 'Ce compte est désactivé' });
        }

        const token = jwt.sign(
            { id: proprietaire._id, role: proprietaire.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const data = proprietaire.toObject();
        delete data.password;

        res.status(200).json({ success: true, message: 'Connexion réussie', token, proprietaire: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer tous les propriétaires
exports.getAll = async (req, res) => {
    try {
        const proprietaires = await Proprietaire.find().select('-password').sort({ createdAt: -1 });

        res.status(200).json({ success: true, total: proprietaires.length, proprietaires });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer un propriétaire par son id
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const proprietaire = await Proprietaire.findById(id).select('-password');
        if (!proprietaire) {
            return res.status(404).json({ success: false, message: 'Propriétaire introuvable' });
        }

        res.status(200).json({ success: true, proprietaire });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Modifier un propriétaire (multipart/form-data, nouvelle photo facultative dans le champ "photo")
// Seuls les champs envoyés sont modifiés. Si une nouvelle photo est envoyée, l'ancienne est supprimée du bucket.
exports.modifier = async (req, res) => {
    // En cas d'échec, la nouvelle photo déjà envoyée sur R2 est supprimée
    const annulerPhoto = () => req.photo && supprimerDeR2([req.photo]).catch(() => {});

    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            annulerPhoto();
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        if (!estAdminOuLuiMeme(req, id)) {
            annulerPhoto();
            return res.status(403).json({ success: false, message: 'Vous ne pouvez modifier que votre propre compte' });
        }

        const proprietaire = await Proprietaire.findById(id);
        if (!proprietaire) {
            annulerPhoto();
            return res.status(404).json({ success: false, message: 'Propriétaire introuvable' });
        }

        if (req.body.telephone && req.body.telephone.trim() !== proprietaire.telephone) {
            const existe = await Proprietaire.findOne({ telephone: req.body.telephone.trim() });
            if (existe) {
                annulerPhoto();
                return res.status(409).json({ success: false, message: 'Ce téléphone est déjà utilisé' });
            }
        }

        if (req.body.email !== undefined) {
            req.body.email = nettoyerEmail(req.body.email);
            if (req.body.email && req.body.email !== proprietaire.email) {
                const existe = await Proprietaire.findOne({ email: req.body.email });
                if (existe) {
                    annulerPhoto();
                    return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
                }
            }
        }

        const champs = ROLES_ADMIN.includes(req.admin.role) ? [...CHAMPS_MODIFIABLES, ...CHAMPS_ADMIN] : CHAMPS_MODIFIABLES;
        champs.forEach((champ) => {
            if (req.body[champ] !== undefined) proprietaire[champ] = req.body[champ];
        });

        if (req.body.password) {
            proprietaire.password = await bcrypt.hash(req.body.password, 10);
        }

        const anciennePhoto = proprietaire.photo;
        if (req.photo) proprietaire.photo = req.photo;

        await proprietaire.save();

        // La modification est enregistrée : on peut supprimer l'ancienne photo du bucket
        if (req.photo && anciennePhoto && anciennePhoto !== req.photo) {
            try {
                await supprimerDeR2([anciennePhoto]);
            } catch (erreur) {
                console.error("Suppression de l'ancienne photo R2 échouée :", erreur.message);
            }
        }

        const data = proprietaire.toObject();
        delete data.password;

        res.status(200).json({ success: true, message: 'Propriétaire modifié avec succès', proprietaire: data });
    } catch (error) {
        annulerPhoto();
        if (error.name === 'ValidationError' || error.name === 'CastError') {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Supprimer un propriétaire (et sa photo de profil dans le bucket)
exports.supprimer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        if (!estAdminOuLuiMeme(req, id)) {
            return res.status(403).json({ success: false, message: 'Vous ne pouvez supprimer que votre propre compte' });
        }

        const proprietaire = await Proprietaire.findByIdAndDelete(id);
        if (!proprietaire) {
            return res.status(404).json({ success: false, message: 'Propriétaire introuvable' });
        }

        try {
            await supprimerDeR2([proprietaire.photo]);
        } catch (erreur) {
            console.error('Suppression de la photo R2 échouée :', erreur.message);
        }

        res.status(200).json({ success: true, message: 'Propriétaire supprimé avec succès' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
