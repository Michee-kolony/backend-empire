const mongoose = require('mongoose');
const Paiement = require('../models/paiement');
const Propriete = require('../models/propriete');
const Proprietaire = require('../models/proprietaire');
const Administrateur = require('../models/admin');

const CHAMPS_MODIFIABLES = [
    'montant', 'devise', 'modePaiement', 'datePaiement',
    'periodeDebut', 'periodeFin', 'description'
];

const repondreErreur = (error, res) => {
    if (error.code === 11000) {
        return res.status(409).json({ success: false, message: 'Cette référence de reçu existe déjà' });
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

const verifierIdentifiant = (id, res, libelle = 'Identifiant') => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ success: false, message: `${libelle} invalide` });
        return false;
    }
    return true;
};

const peuplerPaiement = (requete) => requete
    .populate('propriete')
    .populate('proprietaire', '-password')
    .populate('adminEnregistreur', '-password');

const trouverPropriete = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const error = new Error('Identifiant de propriété invalide');
        error.statut = 400;
        throw error;
    }

    const propriete = await Propriete.findById(id).select('proprietaire');
    if (!propriete) {
        const error = new Error('Propriété introuvable');
        error.statut = 404;
        throw error;
    }
    if (!(await Proprietaire.exists({ _id: propriete.proprietaire }))) {
        const error = new Error('Propriétaire introuvable pour cette propriété');
        error.statut = 400;
        throw error;
    }
    return propriete;
};

const repondreErreurCreation = (error, res) => {
    if (error.statut) {
        return res.status(error.statut).json({ success: false, message: error.message });
    }
    return repondreErreur(error, res);
};

exports.ajouter = async (req, res) => {
    try {
        const { propriete: proprieteId } = req.body;
        if (!proprieteId || req.body.montant === undefined || !req.body.modePaiement) {
            return res.status(400).json({
                success: false,
                message: 'La propriété, le montant et le mode de paiement sont obligatoires'
            });
        }

        if (!mongoose.Types.ObjectId.isValid(req.admin.id)) {
            return res.status(401).json({ success: false, message: 'Administrateur invalide' });
        }

        const [propriete, administrateur] = await Promise.all([
            trouverPropriete(proprieteId),
            Administrateur.exists({ _id: req.admin.id })
        ]);
        if (!administrateur) {
            return res.status(401).json({ success: false, message: 'Administrateur introuvable' });
        }

        const data = {};
        CHAMPS_MODIFIABLES.forEach((champ) => {
            if (req.body[champ] !== undefined) data[champ] = req.body[champ];
        });
        data.propriete = propriete._id;
        data.proprietaire = propriete.proprietaire;
        data.adminEnregistreur = req.admin.id;

        const paiement = await Paiement.create(data);
        await peuplerPaiement(paiement);
        return res.status(201).json({ success: true, message: 'Paiement enregistré avec succès', paiement });
    } catch (error) {
        return repondreErreurCreation(error, res);
    }
};

exports.getAll = async (req, res) => {
    try {
        const filtre = {};
        for (const champ of ['propriete', 'proprietaire']) {
            if (req.query[champ] !== undefined) {
                if (!verifierIdentifiant(req.query[champ], res, `Identifiant ${champ}`)) return;
                filtre[champ] = req.query[champ];
            }
        }
        const paiements = await peuplerPaiement(Paiement.find(filtre).sort({ datePaiement: -1, createdAt: -1 }));
        return res.status(200).json({ success: true, total: paiements.length, paiements });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.getById = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await peuplerPaiement(Paiement.findById(req.params.id));
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }
        return res.status(200).json({ success: true, paiement });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.modifier = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await Paiement.findById(req.params.id);
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }

        if (req.body.propriete !== undefined) {
            const propriete = await trouverPropriete(req.body.propriete);
            paiement.propriete = propriete._id;
            paiement.proprietaire = propriete.proprietaire;
        }
        CHAMPS_MODIFIABLES.forEach((champ) => {
            if (req.body[champ] !== undefined) paiement[champ] = req.body[champ];
        });

        await paiement.save();
        await peuplerPaiement(paiement);
        return res.status(200).json({ success: true, message: 'Paiement modifié avec succès', paiement });
    } catch (error) {
        return repondreErreurCreation(error, res);
    }
};

exports.supprimer = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await Paiement.findByIdAndDelete(req.params.id);
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }
        return res.status(200).json({ success: true, message: 'Paiement supprimé avec succès' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};