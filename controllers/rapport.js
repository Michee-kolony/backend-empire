const mongoose = require('mongoose');
const Rapport = require('../models/rapport');
const Presence = require('../models/presence');
const Administrateur = require('../models/admin');
require('../models/gardien');
require('../models/propriete');
require('../models/proprietaire');
require('../models/affectation');
const { jourLocal, instantLocal, decalerJour } = require('../utils/horaires');

// Un rapport peut être écrit pendant le service ou jusqu'à 24 h après sa fin
const DELAI_RAPPORT_HEURES = Number(process.env.RAPPORT_DELAI_HEURES ?? 24);

const CHAMPS_GARDIEN = 'matricule nom postnom prenom photoProfil telephonePrincipal';
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

const exigerGardien = (req) => {
    if (req.admin.role !== 'GARDIEN') throw erreur(403, 'Action réservée aux gardiens');
};

const peupler = (cible) => cible.populate([
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE, populate: { path: 'proprietaire', select: 'nom postnom prenom telephone' } },
    { path: 'affectation', select: 'role heureDebut heureFin joursService' },
    { path: 'presence', select: 'jourService debutPrevu finPrevue heureArrivee heureDepart' },
    { path: 'traitePar', select: '-password' }
]);

const lireObjet = (valeur) => {
    const objet = String(valeur ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (!Rapport.OBJETS[objet]) throw erreur(400, `Objet invalide : ${Object.keys(Rapport.OBJETS).join(', ')}`);
    return objet;
};

// Période "du" / "au" en jours locaux (AAAA-MM-JJ), les deux inclus
const filtrePeriode = (query) => {
    if (query.du === undefined && query.au === undefined) return {};
    const format = /^\d{4}-\d{2}-\d{2}$/;
    const au = query.au ?? jourLocal(new Date());
    const du = query.du ?? '2000-01-01';
    if (!format.test(du) || !format.test(au)) throw erreur(400, 'Dates "du" et "au" au format AAAA-MM-JJ');
    return { createdAt: { $gte: instantLocal(du), $lt: instantLocal(decalerJour(au, 1)) } };
};

// Service auquel le rapport se rattache : celui indiqué, sinon le service en cours, sinon le dernier terminé
const trouverService = async (gardienId, presenceId) => {
    const limite = new Date(Date.now() - DELAI_RAPPORT_HEURES * 3600000);

    if (presenceId !== undefined && presenceId !== '') {
        verifierIdentifiant(presenceId, 'Identifiant de service');
        const service = await Presence.findById(presenceId);
        if (!service || String(service.gardien) !== String(gardienId)) throw erreur(404, 'Service introuvable');
        if (service.heureDepart && service.heureDepart < limite) {
            throw erreur(400, `Ce service est terminé depuis plus de ${DELAI_RAPPORT_HEURES} h : le rapport n'est plus possible`);
        }
        return service;
    }

    const service = await Presence.findOne({
        gardien: gardienId,
        $or: [{ heureDepart: null }, { heureDepart: { $gte: limite } }]
    }).sort({ heureArrivee: -1 });
    if (!service) {
        throw erreur(400, `Aucun service en cours ni terminé depuis moins de ${DELAI_RAPPORT_HEURES} h : un rapport se fait après un service`);
    }
    return service;
};

// Liste des objets pour le select : [{ valeur, libelle }]
exports.objets = (req, res) => {
    res.status(200).json({
        success: true,
        objets: Object.entries(Rapport.OBJETS).map(([valeur, libelle]) => ({ valeur, libelle }))
    });
};

// ---------- Gardien ----------

// Envoyer un rapport (token GARDIEN). Body : objet, description, [presence]
exports.ajouter = async (req, res) => {
    try {
        exigerGardien(req);
        if (!req.body.objet || !req.body.description) {
            throw erreur(400, 'L\'objet et la description du rapport sont obligatoires');
        }
        const objet = lireObjet(req.body.objet);
        const service = await trouverService(req.admin.id, req.body.presence);

        const rapport = await Rapport.create({
            gardien: req.admin.id,
            propriete: service.propriete,
            affectation: service.affectation,
            presence: service._id,
            objet,
            description: req.body.description
        });

        await peupler(rapport);
        return res.status(201).json({ success: true, message: 'Rapport envoyé', rapport });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Rapports du gardien connecté. Query : objet, du, au
exports.mesRapports = async (req, res) => {
    try {
        exigerGardien(req);
        const filtre = { gardien: req.admin.id, ...filtrePeriode(req.query) };
        if (req.query.objet !== undefined) filtre.objet = lireObjet(req.query.objet);

        const rapports = await peupler(Rapport.find(filtre).sort({ createdAt: -1 }));
        return res.status(200).json({ success: true, total: rapports.length, rapports });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Entreprise (admin) ----------

// Tous les rapports. Query : gardien, propriete, objet, statut, du, au
exports.getAll = async (req, res) => {
    try {
        const filtre = filtrePeriode(req.query);
        for (const champ of ['gardien', 'propriete']) {
            if (req.query[champ] !== undefined) {
                verifierIdentifiant(req.query[champ], `Identifiant ${champ}`);
                filtre[champ] = req.query[champ];
            }
        }
        if (req.query.objet !== undefined) filtre.objet = lireObjet(req.query.objet);
        if (req.query.statut !== undefined) {
            if (!Rapport.STATUTS.includes(req.query.statut)) throw erreur(400, `Statut invalide : ${Rapport.STATUTS.join(', ')}`);
            filtre.statut = req.query.statut;
        }

        const [rapports, nonLus] = await Promise.all([
            peupler(Rapport.find(filtre).sort({ createdAt: -1 })),
            Rapport.countDocuments({ statut: 'nouveau' })
        ]);
        return res.status(200).json({ success: true, total: rapports.length, nonLus, rapports });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Un rapport : l'admin, ou le gardien qui l'a écrit
exports.getById = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const rapport = await peupler(Rapport.findById(req.params.id));
        if (!rapport) throw erreur(404, 'Rapport introuvable');

        const estAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(req.admin.role);
        const estAuteur = req.admin.role === 'GARDIEN' && String(rapport.gardien?._id) === String(req.admin.id);
        if (!estAdmin && !estAuteur) throw erreur(403, 'Accès refusé');

        return res.status(200).json({ success: true, rapport });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Suivi par l'entreprise (admin). Body : statut ("nouveau" | "lu" | "traite"), [commentaireAdmin]
exports.changerStatut = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        if (!mongoose.Types.ObjectId.isValid(req.admin.id) || !(await Administrateur.exists({ _id: req.admin.id }))) {
            throw erreur(401, 'Administrateur introuvable');
        }
        const { statut, commentaireAdmin } = req.body;
        if (!Rapport.STATUTS.includes(statut)) throw erreur(400, `Statut invalide : ${Rapport.STATUTS.join(', ')}`);

        const rapport = await Rapport.findById(req.params.id);
        if (!rapport) throw erreur(404, 'Rapport introuvable');

        rapport.statut = statut;
        rapport.traitePar = statut === 'nouveau' ? null : req.admin.id;
        rapport.traiteLe = statut === 'nouveau' ? null : new Date();
        if (commentaireAdmin !== undefined) rapport.commentaireAdmin = commentaireAdmin;
        await rapport.save();

        await peupler(rapport);
        return res.status(200).json({ success: true, message: 'Rapport mis à jour', rapport });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer un rapport (super admin)
exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const rapport = await Rapport.findByIdAndDelete(req.params.id);
        if (!rapport) throw erreur(404, 'Rapport introuvable');
        return res.status(200).json({ success: true, message: 'Rapport supprimé' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
