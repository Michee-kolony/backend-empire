const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Gardien = require('../models/gardien');
const { JWT_SECRET } = require('../middleware/auth');
const { supprimerDeR2 } = require('../middleware/upload');

const CHAMPS_OBLIGATOIRES = [
    'nom', 'postnom', 'prenom', 'sexe', 'dateNaissance', 'lieuNaissance',
    'nationalite', 'etatCivil', 'taille', 'telephonePrincipal', 'email', 'password',
    'adresseActuelle', 'commune', 'quartier', 'avenue'
];

// Inscription d'un gardien (multipart/form-data, photo de profil dans le champ "photoProfil")
exports.inscription = async (req, res) => {
    try {
        const manquants = CHAMPS_OBLIGATOIRES.filter((champ) => !req.body[champ]);
        if (manquants.length) {
            return res.status(400).json({ success: false, message: 'Champs obligatoires manquants : ' + manquants.join(', ') });
        }

        if (!req.photo) {
            return res.status(400).json({ success: false, message: 'La photo de profil est obligatoire' });
        }

        const {
            nom, postnom, prenom, sexe, dateNaissance, lieuNaissance, nationalite, etatCivil, taille,
            telephonePrincipal, telephoneSecondaire, email, password,
            adresseActuelle, commune, quartier, avenue, statut, lat, lng
        } = req.body;

        const existe = await Gardien.findOne({ email: email.toLowerCase().trim() });
        if (existe) {
            return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
        }

        const hash = await bcrypt.hash(password, 10);

        const gardien = await Gardien.create({
            nom, postnom, prenom, sexe, dateNaissance, lieuNaissance, nationalite, etatCivil, taille,
            photoProfil: req.photo,
            telephonePrincipal, telephoneSecondaire,
            email, password: hash,
            adresseActuelle, commune, quartier, avenue, statut,
            coordonnees: {
                lat: lat !== undefined && lat !== '' ? Number(lat) : null,
                lng: lng !== undefined && lng !== '' ? Number(lng) : null
            }
        });

        const data = gardien.toObject();
        delete data.password;

        res.status(201).json({ success: true, message: 'Gardien créé avec succès', gardien: data });
    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Connexion d'un gardien : renvoie le token et toutes ses données
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email et mot de passe sont obligatoires' });
        }

        const gardien = await Gardien.findOne({ email: email.toLowerCase().trim() });
        if (!gardien) {
            return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
        }

        const valide = await bcrypt.compare(password, gardien.password);
        if (!valide) {
            return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
        }

        const token = jwt.sign(
            { id: gardien._id, role: 'GARDIEN' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const data = gardien.toObject();
        delete data.password;

        res.status(200).json({ success: true, message: 'Connexion réussie', token, gardien: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer tous les gardiens
exports.getAll = async (req, res) => {
    try {
        const gardiens = await Gardien.find().select('-password').sort({ createdAt: -1 });

        res.status(200).json({ success: true, total: gardiens.length, gardiens });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer un gardien par son id
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const gardien = await Gardien.findById(id).select('-password');
        if (!gardien) {
            return res.status(404).json({ success: false, message: 'Gardien introuvable' });
        }

        res.status(200).json({ success: true, gardien });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const CHAMPS_MODIFIABLES = [
    'nom', 'postnom', 'prenom', 'sexe', 'dateNaissance', 'lieuNaissance', 'nationalite', 'etatCivil', 'taille',
    'telephonePrincipal', 'telephoneSecondaire', 'email',
    'adresseActuelle', 'commune', 'quartier', 'avenue', 'statut'
];

// Modifier un gardien (multipart/form-data, nouvelle photo de profil facultative dans le champ "photoProfil")
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

        const gardien = await Gardien.findById(id);
        if (!gardien) {
            annulerPhoto();
            return res.status(404).json({ success: false, message: 'Gardien introuvable' });
        }

        if (req.body.email && req.body.email.toLowerCase().trim() !== gardien.email) {
            const existe = await Gardien.findOne({ email: req.body.email.toLowerCase().trim() });
            if (existe) {
                annulerPhoto();
                return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
            }
        }

        CHAMPS_MODIFIABLES.forEach((champ) => {
            if (req.body[champ] !== undefined) gardien[champ] = req.body[champ];
        });

        if (req.body.password) {
            gardien.password = await bcrypt.hash(req.body.password, 10);
        }

        if (req.body.lat !== undefined) gardien.coordonnees.lat = req.body.lat !== '' ? Number(req.body.lat) : null;
        if (req.body.lng !== undefined) gardien.coordonnees.lng = req.body.lng !== '' ? Number(req.body.lng) : null;

        const anciennePhoto = gardien.photoProfil;
        if (req.photo) gardien.photoProfil = req.photo;

        await gardien.save();

        // La modification est enregistrée : on peut supprimer l'ancienne photo du bucket
        if (req.photo && anciennePhoto !== req.photo) {
            try {
                await supprimerDeR2([anciennePhoto]);
            } catch (erreur) {
                console.error("Suppression de l'ancienne photo R2 échouée :", erreur.message);
            }
        }

        const data = gardien.toObject();
        delete data.password;

        res.status(200).json({ success: true, message: 'Gardien modifié avec succès', gardien: data });
    } catch (error) {
        annulerPhoto();
        if (error.name === 'ValidationError' || error.name === 'CastError') {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Changer le statut d'un gardien : "en service" ou "non en service"
exports.changerStatut = async (req, res) => {
    try {
        const { id } = req.params;
        const { statut } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        if (!['en service', 'non en service'].includes(statut)) {
            return res.status(400).json({ success: false, message: 'Statut invalide : "en service" ou "non en service"' });
        }

        const gardien = await Gardien.findByIdAndUpdate(id, { statut }, { new: true }).select('-password');
        if (!gardien) {
            return res.status(404).json({ success: false, message: 'Gardien introuvable' });
        }

        res.status(200).json({ success: true, message: 'Statut mis à jour', gardien });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Ajouter un commentaire sur un gardien (photo du propriétaire dans le champ "photoProprietaire")
exports.ajouterCommentaire = async (req, res) => {
    try {
        const { id } = req.params;
        const { nomProprietaire, contenu } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        if (!nomProprietaire || !contenu) {
            return res.status(400).json({ success: false, message: 'Nom du propriétaire et contenu sont obligatoires' });
        }

        const commentaire = {
            photoProprietaire: req.photo || req.body.photoProprietaire || '',
            nomProprietaire,
            contenu
        };

        const gardien = await Gardien.findByIdAndUpdate(
            id,
            { $push: { commentaires: commentaire } },
            { new: true }
        ).select('-password');

        if (!gardien) {
            return res.status(404).json({ success: false, message: 'Gardien introuvable' });
        }

        res.status(201).json({ success: true, message: 'Commentaire ajouté', commentaires: gardien.commentaires });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Supprimer un gardien
exports.supprimer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const gardien = await Gardien.findByIdAndDelete(id);
        if (!gardien) {
            return res.status(404).json({ success: false, message: 'Gardien introuvable' });
        }

        // Supprime aussi du bucket sa photo de profil et les photos des propriétaires dans ses commentaires
        const photos = [gardien.photoProfil, ...gardien.commentaires.map((c) => c.photoProprietaire)];
        try {
            await supprimerDeR2(photos);
        } catch (erreur) {
            console.error('Suppression des photos R2 échouée :', erreur.message);
        }

        res.status(200).json({ success: true, message: 'Gardien supprimé avec succès' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
