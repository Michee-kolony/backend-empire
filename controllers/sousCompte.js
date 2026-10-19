const mongoose = require('mongoose');
const SousCompte = require('../models/sousCompte');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Comptes principaux pouvant gérer leurs sous-comptes
const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE'];

// Champs que le propriétaire renseigne pour inscrire le locataire d'un logement
const CHAMPS_LOCATAIRE = ['libelle', 'nom', 'postnom', 'prenom', 'telephone', 'dateEntree'];

// Champs du locataire retirés quand le logement est libéré
const CHAMPS_OCCUPANT = ['nom', 'postnom', 'prenom', 'telephone', 'dateEntree'];

const POPULATE_PROPRIETE = { path: 'propriete', select: 'nomReference typePropriete commune quartier avenue numero nombreLogements' };

const estAdmin = (req) => ROLES_ADMIN.includes(req.admin.role);

const estProprietaire = (req) => ROLES_PROPRIETAIRE.includes(req.admin.role);

// Le compte connecté est le compte principal auquel ce sous-compte est rattaché
const estSonProprietaire = (req, sousCompte) =>
    estProprietaire(req) && String(sousCompte.proprietaire) === String(req.admin.id);

const repondreErreur = (error, res) => {
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

// Charge le sous-compte de l'URL s'il appartient au propriétaire connecté (seul autorisé à le modifier)
const chargerPourModification = async (req, res) => {
    const sousCompte = await chargerSousCompte(req, res);
    if (!sousCompte) return null;
    if (!estSonProprietaire(req, sousCompte)) {
        res.status(403).json({ success: false, message: 'Seul le propriétaire peut gérer les locataires de ses logements' });
        return null;
    }
    return sousCompte;
};

// Liste des sous-comptes :
// - propriétaire : uniquement les siens (filtre facultatif ?propriete=<id>&statut=libre|occupe)
// - admin (consultation) : tous (filtres facultatifs ?proprietaire=<id>&propriete=<id>&statut=libre|occupe)
exports.getAll = async (req, res) => {
    try {
        if (!estAdmin(req) && !estProprietaire(req)) {
            return res.status(403).json({ success: false, message: 'Réservé aux propriétaires et administrateurs' });
        }

        const filtre = {};
        if (estAdmin(req)) {
            if (req.query.proprietaire) filtre.proprietaire = req.query.proprietaire;
        } else {
            filtre.proprietaire = req.admin.id;
        }
        if (req.query.propriete) filtre.propriete = req.query.propriete;
        if (req.query.statut === 'occupe') filtre.nom = { $exists: true };
        if (req.query.statut === 'libre') filtre.nom = { $exists: false };

        const sousComptes = await SousCompte.find(filtre)
            .populate(POPULATE_PROPRIETE)
            .sort({ propriete: 1, numero: 1 });

        const occupes = sousComptes.filter((s) => s.nom).length;

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

// Récupérer un sous-compte (son propriétaire ou un admin)
exports.getById = async (req, res) => {
    try {
        const sousCompte = await chargerSousCompte(req, res);
        if (!sousCompte) return;

        if (!estAdmin(req) && !estSonProprietaire(req, sousCompte)) {
            return res.status(403).json({ success: false, message: 'Accès refusé à ce sous-compte' });
        }

        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Inscrire ou modifier le locataire d'un logement (propriétaire uniquement) : seuls les champs envoyés sont modifiés.
// Le nom suffit pour occuper le logement ; le téléphone est un simple contact facultatif.
exports.modifier = async (req, res) => {
    try {
        const sousCompte = await chargerPourModification(req, res);
        if (!sousCompte) return;

        CHAMPS_LOCATAIRE.forEach((champ) => {
            if (req.body[champ] === undefined) return;
            const valeur = typeof req.body[champ] === 'string' ? req.body[champ].trim() : req.body[champ];
            // Une valeur vide retire le champ
            sousCompte[champ] = valeur === '' || valeur === null ? undefined : valeur;
        });

        if (!sousCompte.libelle) {
            return res.status(400).json({ success: false, message: 'Le libellé du logement est obligatoire' });
        }

        const renseignes = CHAMPS_OCCUPANT.filter((champ) => sousCompte[champ]);
        if (renseignes.length && !sousCompte.nom) {
            return res.status(400).json({ success: false, message: 'Le nom du locataire est obligatoire' });
        }
        if (sousCompte.nom && !sousCompte.dateEntree) sousCompte.dateEntree = new Date();

        await sousCompte.save();
        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, message: 'Locataire enregistré avec succès', sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Libérer un logement (propriétaire uniquement) : retire le locataire, le sous-compte redevient libre
exports.liberer = async (req, res) => {
    try {
        const sousCompte = await chargerPourModification(req, res);
        if (!sousCompte) return;

        CHAMPS_OCCUPANT.forEach((champ) => { sousCompte[champ] = undefined; });
        await sousCompte.save();
        await sousCompte.populate(POPULATE_PROPRIETE);

        res.status(200).json({ success: true, message: 'Logement libéré avec succès', sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};
