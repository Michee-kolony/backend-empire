const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Proprietaire = require('../models/proprietaire');
const SousCompte = require('../models/sousCompte');
const { JWT_SECRET } = require('../middleware/auth');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Comptes principaux pouvant gérer leurs sous-comptes
const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE'];

// Champs que le propriétaire (ou un admin) renseigne pour attribuer un locataire au logement
const CHAMPS_GESTION = ['libelle', 'nom', 'postnom', 'prenom', 'telephone', 'email', 'dateEntree', 'actif'];

// Champs que le locataire peut modifier lui-même (en plus de son mot de passe)
const CHAMPS_LOCATAIRE = ['email'];

// Champs du locataire retirés quand le logement est libéré
const CHAMPS_OCCUPANT = ['nom', 'postnom', 'prenom', 'telephone', 'email', 'password', 'dateEntree'];

const POPULATE_PROPRIETE = { path: 'propriete', select: 'nomReference typePropriete commune quartier avenue numero nombreLogements' };

const estAdmin = (req) => ROLES_ADMIN.includes(req.admin.role);

// Le compte connecté est le compte principal auquel ce sous-compte est rattaché
const estSonProprietaire = (req, sousCompte) =>
    !req.admin.sousCompte && ROLES_PROPRIETAIRE.includes(req.admin.role)
    && String(sousCompte.proprietaire._id || sousCompte.proprietaire) === String(req.admin.id);

// Le compte connecté est le locataire de ce sous-compte
const estSonLocataire = (req, sousCompte) => req.admin.sousCompte && String(sousCompte._id) === String(req.admin.id);

const peutGerer = (req, sousCompte) => estAdmin(req) || estSonProprietaire(req, sousCompte);

const sansMotDePasse = (sousCompte) => {
    const data = sousCompte.toObject();
    delete data.password;
    return data;
};

const repondreErreur = (error, res) => {
    if (error.code === 11000) {
        const champ = Object.keys(error.keyPattern || {})[0] === 'email' ? 'Cet email' : 'Ce téléphone';
        return res.status(409).json({ success: false, message: `${champ} est déjà utilisé par un autre locataire` });
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: error.message });
};

// Charge le sous-compte de l'URL, ou répond 400/404 et renvoie null
const chargerSousCompte = async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ success: false, message: 'Identifiant invalide' });
        return null;
    }
    const sousCompte = await SousCompte.findById(id);
    if (!sousCompte) {
        res.status(404).json({ success: false, message: 'Sous-compte introuvable' });
        return null;
    }
    return sousCompte;
};

// Connexion d'un locataire avec le téléphone (ou l'email) et le mot de passe définis par son propriétaire
exports.login = async (req, res) => {
    try {
        const { identifiant, password } = req.body;

        if (!identifiant || !password) {
            return res.status(400).json({ success: false, message: 'Téléphone (ou email) et mot de passe sont obligatoires' });
        }

        const valeur = identifiant.trim();
        const sousCompte = await SousCompte.findOne({
            $or: [{ telephone: valeur }, { email: valeur.toLowerCase() }]
        });
        if (!sousCompte || !sousCompte.password || !(await bcrypt.compare(password, sousCompte.password))) {
            return res.status(401).json({ success: false, message: 'Identifiant ou mot de passe incorrect' });
        }

        // Le sous-compte est bloqué s'il est désactivé ou si le compte principal l'est
        const proprietaire = await Proprietaire.findById(sousCompte.proprietaire).select('actif');
        if (!sousCompte.actif || !proprietaire || !proprietaire.actif) {
            return res.status(403).json({ success: false, message: 'Ce compte est désactivé' });
        }

        const token = jwt.sign(
            {
                id: sousCompte._id,
                role: 'LOCATAIRE',
                sousCompte: true,
                proprietaire: sousCompte.proprietaire,
                propriete: sousCompte.propriete
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, message: 'Connexion réussie', token, sousCompte: sansMotDePasse(sousCompte) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Liste des sous-comptes :
// - propriétaire : uniquement les siens (filtre facultatif ?propriete=<id>&statut=libre|occupe)
// - admin : tous (filtres facultatifs ?proprietaire=<id>&propriete=<id>&statut=libre|occupe)
exports.getAll = async (req, res) => {
    try {
        if (!estAdmin(req) && (req.admin.sousCompte || !ROLES_PROPRIETAIRE.includes(req.admin.role))) {
            return res.status(403).json({ success: false, message: 'Réservé aux propriétaires et administrateurs' });
        }

        const filtre = {};
        if (estAdmin(req)) {
            if (req.query.proprietaire) filtre.proprietaire = req.query.proprietaire;
        } else {
            filtre.proprietaire = req.admin.id;
        }
        if (req.query.propriete) filtre.propriete = req.query.propriete;
        if (req.query.statut === 'occupe') filtre.telephone = { $exists: true };
        if (req.query.statut === 'libre') filtre.telephone = { $exists: false };

        const sousComptes = await SousCompte.find(filtre)
            .select('-password')
            .populate(POPULATE_PROPRIETE)
            .sort({ propriete: 1, numero: 1 });

        const occupes = sousComptes.filter((s) => s.telephone).length;

        res.status(200).json({
            success: true,
            total: sousComptes.length,
            occupes,
            libres: sousComptes.length - occupes,
            sousComptes
        });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Récupérer un sous-compte (son propriétaire, son locataire ou un admin)
exports.getById = async (req, res) => {
    try {
        const sousCompte = await chargerSousCompte(req, res);
        if (!sousCompte) return;

        if (!peutGerer(req, sousCompte) && !estSonLocataire(req, sousCompte)) {
            return res.status(403).json({ success: false, message: 'Accès refusé à ce sous-compte' });
        }

        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, sousCompte: sansMotDePasse(sousCompte) });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Modifier un sous-compte : seuls les champs envoyés sont modifiés.
// - propriétaire / admin : attribue ou modifie le locataire (nom, téléphone, mot de passe...), le libellé, l'état actif
// - locataire : son email et son mot de passe uniquement
// Un logement occupé doit avoir au minimum un nom, un téléphone et un mot de passe.
exports.modifier = async (req, res) => {
    try {
        const sousCompte = await chargerSousCompte(req, res);
        if (!sousCompte) return;

        let champs;
        if (peutGerer(req, sousCompte)) champs = CHAMPS_GESTION;
        else if (estSonLocataire(req, sousCompte)) champs = CHAMPS_LOCATAIRE;
        else return res.status(403).json({ success: false, message: 'Accès refusé à ce sous-compte' });

        champs.forEach((champ) => {
            if (req.body[champ] === undefined) return;
            const valeur = typeof req.body[champ] === 'string' ? req.body[champ].trim() : req.body[champ];
            // Une valeur vide retire le champ (sinon conflit avec les index uniques)
            sousCompte[champ] = valeur === '' || valeur === null ? undefined : valeur;
        });

        if (req.body.password) {
            sousCompte.password = await bcrypt.hash(req.body.password, 10);
        }

        if (sousCompte.telephone || sousCompte.email || sousCompte.nom) {
            if (!sousCompte.nom || !sousCompte.telephone || !sousCompte.password) {
                return res.status(400).json({
                    success: false,
                    message: 'Nom, téléphone et mot de passe du locataire sont obligatoires pour occuper le logement'
                });
            }
            if (!sousCompte.dateEntree) sousCompte.dateEntree = new Date();
        }

        await sousCompte.save();
        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, message: 'Sous-compte modifié avec succès', sousCompte: sansMotDePasse(sousCompte) });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Libérer un logement : retire le locataire et ses identifiants, le sous-compte redevient libre
exports.liberer = async (req, res) => {
    try {
        const sousCompte = await chargerSousCompte(req, res);
        if (!sousCompte) return;

        if (!peutGerer(req, sousCompte)) {
            return res.status(403).json({ success: false, message: 'Accès refusé à ce sous-compte' });
        }

        CHAMPS_OCCUPANT.forEach((champ) => { sousCompte[champ] = undefined; });
        await sousCompte.save();
        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, message: 'Logement libéré avec succès', sousCompte: sansMotDePasse(sousCompte) });
    } catch (error) {
        repondreErreur(error, res);
    }
};
