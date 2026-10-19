const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const SousCompte = require('../models/sousCompte');
const Locataire = require('../models/locataire');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Comptes principaux pouvant gérer leurs sous-comptes
const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE'];

// Champs que le propriétaire renseigne pour inscrire le locataire d'un logement
const CHAMPS_LOCATAIRE = ['libelle', 'nom', 'postnom', 'prenom', 'telephone', 'dateEntree'];

// Champs du locataire retirés quand le logement est libéré
const CHAMPS_OCCUPANT = ['nom', 'postnom', 'prenom', 'telephone', 'dateEntree'];

// Champs de la fiche recopiés sur le compte de connexion du locataire (nom affiché dans le chat)
const CHAMPS_COMPTE = ['nom', 'postnom', 'prenom', 'telephone'];

const MOT_DE_PASSE_MIN = 6;
const FORMAT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const POPULATE_PROPRIETE = { path: 'propriete', select: 'nomReference typePropriete commune quartier avenue numero nombreLogements' };
// Accès à l'application du locataire (jamais le mot de passe)
const POPULATE_LOCATAIRE = { path: 'locataire', select: 'email actif' };
const POPULATE = [POPULATE_PROPRIETE, POPULATE_LOCATAIRE];

const estAdmin = (req) => ROLES_ADMIN.includes(req.admin.role);

const estProprietaire = (req) => ROLES_PROPRIETAIRE.includes(req.admin.role);

// Le compte connecté est le compte principal auquel ce sous-compte est rattaché
const estSonProprietaire = (req, sousCompte) =>
    estProprietaire(req) && String(sousCompte.proprietaire) === String(req.admin.id);

const erreur = (statut, message) => Object.assign(new Error(message), { statut });

const repondreErreur = (error, res) => {
    if (error.statut) return res.status(error.statut).json({ success: false, message: error.message });
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé par un autre locataire' });
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
            .populate(POPULATE)
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

        await sousCompte.populate(POPULATE);

        res.status(200).json({ success: true, sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Lit l'accès à l'application demandé par le propriétaire (email / mot de passe) :
// - rien d'envoyé : accès inchangé
// - email vide : accès retiré (le compte du locataire est supprimé)
// - email (+ mot de passe à la création, facultatif ensuite) : accès créé ou modifié
const lireAcces = async (req, sousCompte) => {
    const { email: emailBrut, password } = req.body;
    if (emailBrut === undefined && !password) return null;

    const compte = sousCompte.locataire ? await Locataire.findById(sousCompte.locataire) : null;
    const email = emailBrut === undefined ? compte?.email : String(emailBrut ?? '').toLowerCase().trim();

    if (!email) {
        if (password) throw erreur(400, "L'email du locataire est obligatoire pour lui donner accès à l'application");
        return { compte, retirer: true };
    }
    if (!FORMAT_EMAIL.test(email)) throw erreur(400, 'Adresse email du locataire invalide');
    if (!compte && !password) throw erreur(400, 'Choisissez un mot de passe pour le locataire');
    if (password && String(password).length < MOT_DE_PASSE_MIN) {
        throw erreur(400, `Le mot de passe du locataire doit contenir au moins ${MOT_DE_PASSE_MIN} caractères`);
    }
    if (await Locataire.exists({ email, _id: { $ne: compte?._id } })) {
        throw erreur(409, 'Cet email est déjà utilisé par un autre locataire');
    }
    return { compte, email, password: password ? String(password) : null };
};

// Crée, met à jour ou supprime le compte de connexion selon l'accès demandé ;
// sans demande, recopie seulement la fiche sur le compte existant
const appliquerAcces = async (sousCompte, acces) => {
    if (acces?.retirer) {
        if (acces.compte) await Locataire.deleteOne({ _id: acces.compte._id });
        sousCompte.locataire = undefined;
        return;
    }

    const compte = acces ? acces.compte : (sousCompte.locataire ? await Locataire.findById(sousCompte.locataire) : null);
    if (!compte && !acces) return;

    const donnees = Object.fromEntries(CHAMPS_COMPTE.map((champ) => [champ, sousCompte[champ]]));
    if (acces) {
        donnees.email = acces.email;
        if (acces.password) donnees.password = await bcrypt.hash(acces.password, 10);
    }

    if (compte) {
        compte.set(donnees);
        await compte.save();
    } else {
        const cree = await Locataire.create({ ...donnees, sousCompte: sousCompte._id, propriete: sousCompte.propriete });
        sousCompte.locataire = cree._id;
    }
};

// Inscrire ou modifier le locataire d'un logement (propriétaire uniquement) : seuls les champs envoyés sont modifiés.
// Le nom suffit pour occuper le logement ; le téléphone est un simple contact facultatif.
// Avec "email" et "password", le locataire peut se connecter à l'application (chat avec le propriétaire
// et les gardiens) ; "password" est facultatif pour modifier un accès existant, un email vide retire l'accès.
exports.modifier = async (req, res) => {
    try {
        const sousCompte = await chargerPourModification(req, res);
        if (!sousCompte) return;

        const acces = await lireAcces(req, sousCompte);

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
        if (!sousCompte.nom && (acces ? !acces.retirer : sousCompte.locataire)) {
            return res.status(400).json({ success: false, message: "Le nom du locataire est obligatoire pour lui donner accès à l'application" });
        }
        if (sousCompte.nom && !sousCompte.dateEntree) sousCompte.dateEntree = new Date();

        await sousCompte.validate();
        await appliquerAcces(sousCompte, acces);
        await sousCompte.save();
        await sousCompte.populate(POPULATE);

        res.status(200).json({ success: true, message: 'Locataire enregistré avec succès', sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};

// Libérer un logement (propriétaire uniquement) : retire le locataire, le sous-compte redevient libre.
// Son compte de connexion est supprimé : ses discussions restent en lecture seule.
exports.liberer = async (req, res) => {
    try {
        const sousCompte = await chargerPourModification(req, res);
        if (!sousCompte) return;

        if (sousCompte.locataire) await Locataire.deleteOne({ _id: sousCompte.locataire });
        CHAMPS_OCCUPANT.forEach((champ) => { sousCompte[champ] = undefined; });
        sousCompte.locataire = undefined;
        await sousCompte.save();
        await sousCompte.populate(POPULATE);

        res.status(200).json({ success: true, message: 'Logement libéré avec succès', sousCompte });
    } catch (error) {
        repondreErreur(error, res);
    }
};
