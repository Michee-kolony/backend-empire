const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Locataire = require('../models/locataire');
const SousCompte = require('../models/sousCompte');
const Propriete = require('../models/propriete');
const Affectation = require('../models/affectation');
const { JWT_SECRET } = require('../middleware/auth');

const MOT_DE_PASSE_MIN = 6;

const CHAMPS_PROPRIETE = 'nomReference typePropriete commune quartier avenue numero photos proprietaire';
const CHAMPS_PROPRIETAIRE = 'nom postnom prenom photo telephone role';
const CHAMPS_GARDIEN = 'nom postnom prenom photoProfil matricule telephonePrincipal statut';

const sansMotDePasse = (locataire) => {
    const data = locataire.toObject();
    delete data.password;
    return data;
};

// Compte du locataire connecté (null s'il a été supprimé, ex. logement libéré, ou désactivé)
const chargerLocataire = async (req) => {
    const locataire = await Locataire.findById(req.admin.id);
    return locataire && locataire.actif ? locataire : null;
};

// Connexion d'un locataire avec l'email et le mot de passe choisis par son propriétaire
// Body : { identifiant (ou email), password }
exports.login = async (req, res) => {
    try {
        const email = String(req.body.identifiant ?? req.body.email ?? '').toLowerCase().trim();
        const { password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email et mot de passe sont obligatoires' });
        }

        const locataire = await Locataire.findOne({ email });
        if (!locataire || !(await bcrypt.compare(String(password), locataire.password))) {
            return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
        }
        if (!locataire.actif) {
            return res.status(403).json({ success: false, message: 'Ce compte est désactivé' });
        }

        // "compte" distingue ce token de celui d'un propriétaire (voir middleware/auth.js)
        const token = jwt.sign(
            { id: locataire._id, role: locataire.role, compte: 'Locataire' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({ success: true, message: 'Connexion réussie', token, locataire: sansMotDePasse(locataire) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Espace du locataire : son compte, son logement, son propriétaire et les gardiens en service
exports.moi = async (req, res) => {
    try {
        const locataire = await chargerLocataire(req);
        if (!locataire) {
            return res.status(401).json({ success: false, message: 'Compte introuvable ou désactivé' });
        }

        const [logement, propriete, affectations] = await Promise.all([
            SousCompte.findById(locataire.sousCompte).select('numero libelle dateEntree'),
            Propriete.findById(locataire.propriete).select(CHAMPS_PROPRIETE).populate('proprietaire', CHAMPS_PROPRIETAIRE),
            Affectation.find({ propriete: locataire.propriete, ...Affectation.filtreStatut('en cours') })
                .select('gardien role heureDebut heureFin')
                .populate('gardien', CHAMPS_GARDIEN)
                .sort({ role: 1 })
        ]);

        const proprietaire = propriete?.proprietaire ?? null;
        const objetPropriete = propriete ? propriete.toObject() : null;
        if (objetPropriete) delete objetPropriete.proprietaire;

        res.status(200).json({
            success: true,
            locataire: sansMotDePasse(locataire),
            logement,
            propriete: objetPropriete,
            proprietaire,
            gardiens: affectations.filter((a) => a.gardien).map((a) => ({
                ...a.gardien.toObject(),
                roleAffectation: a.role,
                heureDebut: a.heureDebut,
                heureFin: a.heureFin
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Changer son mot de passe. Body : { ancienPassword, password }
exports.changerMotDePasse = async (req, res) => {
    try {
        const { ancienPassword, password } = req.body;
        if (!ancienPassword || !password) {
            return res.status(400).json({ success: false, message: 'Ancien et nouveau mot de passe sont obligatoires' });
        }
        if (String(password).length < MOT_DE_PASSE_MIN) {
            return res.status(400).json({ success: false, message: `Le mot de passe doit contenir au moins ${MOT_DE_PASSE_MIN} caractères` });
        }

        const locataire = await chargerLocataire(req);
        if (!locataire) {
            return res.status(401).json({ success: false, message: 'Compte introuvable ou désactivé' });
        }
        if (!(await bcrypt.compare(String(ancienPassword), locataire.password))) {
            return res.status(400).json({ success: false, message: 'Ancien mot de passe incorrect' });
        }

        locataire.password = await bcrypt.hash(String(password), 10);
        await locataire.save();

        res.status(200).json({ success: true, message: 'Mot de passe modifié' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
