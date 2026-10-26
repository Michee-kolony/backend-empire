const mongoose = require('mongoose');
const Evaluation = require('../models/evaluation');
const Propriete = require('../models/propriete');
const Affectation = require('../models/affectation');
const Gardien = require('../models/gardien');
const Proprietaire = require('../models/proprietaire');
const { jourLocal } = require('../utils/horaires');

const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE'];
const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

const CHAMPS_GARDIEN = 'matricule nom postnom prenom photoProfil';
const CHAMPS_PROPRIETE = 'nomReference commune quartier avenue numero photos proprietaire';

const erreur = (statut, message) => Object.assign(new Error(message), { statut });

const repondreErreur = (error, res) => {
    if (error.statut) return res.status(error.statut).json({ success: false, message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

const verifierIdentifiant = (id, libelle = 'Identifiant') => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw erreur(400, `${libelle} invalide`);
};

const nomComplet = (doc) => [doc?.nom, doc?.postnom, doc?.prenom].filter(Boolean).join(' ');

// Mois en cours en heure locale : "AAAA-MM"
const periodeCourante = () => jourLocal(new Date()).slice(0, 7);

const lirePeriode = (valeur) => {
    if (valeur === undefined || valeur === '') return periodeCourante();
    const periode = String(valeur).trim();
    if (!Evaluation.FORMAT_PERIODE.test(periode)) throw erreur(400, 'Période au format AAAA-MM (ex : 2026-10)');
    return periode;
};

// Utilisateur connecté : { id, modele } ou erreur 403
const lireUtilisateur = (jeton) => {
    if (jeton?.compte === 'Locataire') throw erreur(403, 'Les locataires ne peuvent pas évaluer');
    if (jeton?.role === 'GARDIEN') return { id: String(jeton.id), modele: 'Gardien' };
    if (ROLES_PROPRIETAIRE.includes(jeton?.role)) return { id: String(jeton.id), modele: 'Proprietaire' };
    if (ROLES_ADMIN.includes(jeton?.role)) return { id: String(jeton.id), modele: 'Administrateur' };
    throw erreur(403, 'Accès refusé');
};

const peupler = (cible) => cible.populate([
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE, populate: { path: 'proprietaire', select: 'nom postnom prenom photo role' } }
]);

// Le gardien a-t-il été (ou est-il) affecté à cette propriété ? (affectation à n'importe quelle date)
const lienGardienPropriete = (gardienId, proprieteId) =>
    Affectation.exists({ gardien: gardienId, propriete: proprieteId });

// Nom de l'auteur (null si le compte n'existe plus)
const chargerNomAuteur = async (id, modele) => {
    const Modele = modele === 'Gardien' ? Gardien : Proprietaire;
    const doc = await Modele.findById(id).select('nom postnom prenom').lean();
    return doc ? nomComplet(doc) : null;
};

// ---------- Rédaction (propriétaire ou gardien) ----------

// Créer ou mettre à jour MON évaluation d'un mois.
// Body propriétaire : { gardien, propriete, commentaire, [periode] }
// Body gardien       : { propriete, commentaire, [periode] }  (le gardien = lui-même)
exports.enregistrer = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        if (u.modele === 'Administrateur') {
            throw erreur(403, 'L\'évaluation est faite par le propriétaire ou le gardien');
        }

        const periode = lirePeriode(req.body.periode);
        const commentaire = String(req.body.commentaire ?? '').trim();
        if (!commentaire) throw erreur(400, 'L\'appréciation est obligatoire');

        verifierIdentifiant(req.body.propriete, 'Identifiant de propriété');
        const propriete = await Propriete.findById(req.body.propriete).select('proprietaire');
        if (!propriete) throw erreur(404, 'Propriété introuvable');

        let gardienId;
        let proprietaireId;
        if (u.modele === 'Proprietaire') {
            if (String(propriete.proprietaire) !== u.id) throw erreur(403, 'Cette propriété ne vous appartient pas');
            verifierIdentifiant(req.body.gardien, 'Identifiant de gardien');
            gardienId = String(req.body.gardien);
            proprietaireId = u.id;
        } else { // Gardien
            gardienId = u.id;
            proprietaireId = String(propriete.proprietaire);
        }

        if (!(await lienGardienPropriete(gardienId, propriete._id))) {
            throw erreur(403, 'Ce gardien n\'est pas (ou n\'a pas été) affecté à cette propriété');
        }

        const cle = { gardien: gardienId, propriete: propriete._id, periode, auteurModele: u.modele };
        let evaluation = await Evaluation.findOne(cle);
        if (evaluation) {
            evaluation.commentaire = commentaire;
            evaluation.modifie = true;
            evaluation.modifieLe = new Date();
            await evaluation.save();
        } else {
            const auteurNom = await chargerNomAuteur(u.id, u.modele);
            if (!auteurNom) throw erreur(401, 'Compte introuvable');
            try {
                evaluation = await Evaluation.create({ ...cle, auteur: u.id, proprietaire: proprietaireId, auteurNom, commentaire });
            } catch (error) {
                if (error.code === 11000) { // créée au même moment : on reprend l'existante
                    evaluation = await Evaluation.findOne(cle);
                    evaluation.commentaire = commentaire;
                    await evaluation.save();
                } else {
                    throw error;
                }
            }
        }

        await peupler(evaluation);
        return res.status(200).json({ success: true, message: 'Évaluation enregistrée', periodeCourante: periodeCourante(), evaluation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Lecture ----------

const appliquerFiltres = (filtre, query) => {
    if (query.periode !== undefined) filtre.periode = lirePeriode(query.periode);
    if (query.gardien !== undefined) {
        verifierIdentifiant(query.gardien, 'Identifiant gardien');
        filtre.gardien = query.gardien;
    }
    if (query.propriete !== undefined) {
        verifierIdentifiant(query.propriete, 'Identifiant propriete');
        filtre.propriete = query.propriete;
    }
    return filtre;
};

// Évaluations concernant le gardien connecté (la sienne et celle de ses propriétaires).
exports.gardien = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        if (u.modele !== 'Gardien') throw erreur(403, 'Action réservée aux gardiens');

        const filtre = appliquerFiltres({ gardien: u.id }, req.query);
        const evaluations = await peupler(Evaluation.find(filtre).sort({ periode: -1, createdAt: -1 }));
        return res.status(200).json({ success: true, total: evaluations.length, periodeCourante: periodeCourante(), evaluations });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Évaluations sur les propriétés du propriétaire connecté (la sienne et l'auto-évaluation du gardien).
exports.proprietaire = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        if (u.modele !== 'Proprietaire') throw erreur(403, 'Action réservée aux propriétaires');

        const proprietes = await Propriete.find({ proprietaire: u.id }).distinct('_id');
        const filtre = appliquerFiltres({ propriete: { $in: proprietes } }, req.query);
        if (req.query.propriete !== undefined && !proprietes.some((id) => String(id) === String(req.query.propriete))) {
            throw erreur(403, 'Cette propriété ne vous appartient pas');
        }
        const evaluations = await peupler(Evaluation.find(filtre).sort({ periode: -1, createdAt: -1 }));
        return res.status(200).json({ success: true, total: evaluations.length, periodeCourante: periodeCourante(), evaluations });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Entreprise (admin) : accès à toutes les évaluations ----------

// Query : gardien, propriete, proprietaire, periode, auteur (proprietaire | gardien)
exports.getAll = async (req, res) => {
    try {
        const filtre = appliquerFiltres({}, req.query);
        if (req.query.proprietaire !== undefined) {
            verifierIdentifiant(req.query.proprietaire, 'Identifiant proprietaire');
            filtre.proprietaire = req.query.proprietaire;
        }
        if (req.query.auteur !== undefined) {
            const modele = String(req.query.auteur).toLowerCase() === 'gardien' ? 'Gardien'
                : String(req.query.auteur).toLowerCase() === 'proprietaire' ? 'Proprietaire' : null;
            if (!modele) throw erreur(400, 'auteur invalide : proprietaire ou gardien');
            filtre.auteurModele = modele;
        }
        const evaluations = await peupler(Evaluation.find(filtre).sort({ periode: -1, createdAt: -1 }));
        return res.status(200).json({ success: true, total: evaluations.length, periodeCourante: periodeCourante(), evaluations });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer une évaluation (super admin)
exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const evaluation = await Evaluation.findByIdAndDelete(req.params.id);
        if (!evaluation) throw erreur(404, 'Évaluation introuvable');
        return res.status(200).json({ success: true, message: 'Évaluation supprimée' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
