const mongoose = require('mongoose');
const Paiement = require('../models/paiement');
const Propriete = require('../models/propriete');
const Proprietaire = require('../models/proprietaire');
const Administrateur = require('../models/admin');

// Champs libres : ils ne touchent pas à la période d'abonnement
const CHAMPS_MODIFIABLES = ['montant', 'devise', 'modePaiement', 'description'];

const repondreErreur = (error, res) => {
    if (error.statut) {
        return res.status(error.statut).json({ success: false, message: error.message, ...error.details });
    }
    if (error.code === 11000) {
        return res.status(409).json({ success: false, message: 'Cette référence de reçu existe déjà' });
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

const erreur = (statut, message, details) => Object.assign(new Error(message), { statut, details });

const verifierIdentifiant = (id, res, libelle = 'Identifiant') => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ success: false, message: `${libelle} invalide` });
        return false;
    }
    return true;
};

const peuplerRequetePaiement = (requete) => requete
    .populate('propriete')
    .populate('proprietaire', '-password')
    .populate('adminEnregistreur', '-password');

const peuplerDocumentPaiement = async (paiement) => {
    await paiement.populate('propriete');
    await paiement.populate('proprietaire', '-password');
    await paiement.populate('adminEnregistreur', '-password');
    return paiement;
};

const formaterDate = (date) => new Date(date).toLocaleDateString('fr-FR', { timeZone: 'UTC' });

// Ajoute des mois à une date (le 31 janvier + 1 mois donne le 28/29 février)
const ajouterMois = (date, mois) => {
    const resultat = new Date(date);
    const jour = resultat.getUTCDate();
    resultat.setUTCDate(1);
    resultat.setUTCMonth(resultat.getUTCMonth() + mois);
    const dernierJour = new Date(Date.UTC(resultat.getUTCFullYear(), resultat.getUTCMonth() + 1, 0)).getUTCDate();
    resultat.setUTCDate(Math.min(jour, dernierJour));
    return resultat;
};

const lireDuree = (valeur) => {
    const duree = Number(valeur);
    if (valeur === undefined || valeur === '' || !Number.isInteger(duree) || duree < 1) {
        throw erreur(400, 'La durée (dureeMois) doit être un nombre entier de mois supérieur ou égal à 1');
    }
    return duree;
};

const lireDateDebut = (valeur, parDefaut) => {
    if (valeur === undefined || valeur === '' || valeur === null) return parDefaut;
    const date = new Date(valeur);
    if (Number.isNaN(date.getTime())) throw erreur(400, 'Date de début (periodeDebut) invalide');
    return date;
};

const trouverPropriete = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw erreur(400, 'Identifiant de propriété invalide');

    const propriete = await Propriete.findById(id);
    if (!propriete) throw erreur(404, 'Propriété introuvable');
    if (!(await Proprietaire.exists({ _id: propriete.proprietaire }))) {
        throw erreur(400, 'Propriétaire introuvable pour cette propriété');
    }
    return propriete;
};

const erreurAbonnementEnCours = (propriete) => erreur(
    409,
    `Un abonnement est déjà en cours pour cette propriété jusqu'au ${formaterDate(propriete.dateExpirationAbonnement)}`,
    {
        abonnementEnCours: true,
        dateDebutAbonnement: propriete.dateDebutAbonnement,
        dateExpirationAbonnement: propriete.dateExpirationAbonnement
    }
);

// Enregistrer un paiement : il fixe la période d'abonnement de la propriété.
// Body : propriete, dureeMois, montant, modePaiement, [devise], [description], [periodeDebut]
// Refusé (409) tant que l'abonnement actuel de la propriété n'a pas expiré.
exports.ajouter = async (req, res) => {
    try {
        const { propriete: proprieteId } = req.body;
        if (!proprieteId || req.body.montant === undefined || !req.body.modePaiement || req.body.dureeMois === undefined) {
            return res.status(400).json({
                success: false,
                message: 'La propriété, la durée (dureeMois), le montant et le mode de paiement sont obligatoires'
            });
        }

        if (!mongoose.Types.ObjectId.isValid(req.admin.id)) {
            return res.status(401).json({ success: false, message: 'Administrateur invalide' });
        }

        const maintenant = new Date();
        const dureeMois = lireDuree(req.body.dureeMois);
        const periodeDebut = lireDateDebut(req.body.periodeDebut, maintenant);
        const periodeFin = ajouterMois(periodeDebut, dureeMois);
        if (periodeFin <= maintenant) {
            throw erreur(400, 'La période payée est déjà terminée : vérifiez la date de début et la durée');
        }

        const [propriete, administrateur] = await Promise.all([
            trouverPropriete(proprieteId),
            Administrateur.exists({ _id: req.admin.id })
        ]);
        if (!administrateur) {
            return res.status(401).json({ success: false, message: 'Administrateur introuvable' });
        }

        if (propriete.dateExpirationAbonnement && propriete.dateExpirationAbonnement > maintenant) {
            throw erreurAbonnementEnCours(propriete);
        }

        const data = {};
        CHAMPS_MODIFIABLES.forEach((champ) => {
            if (req.body[champ] !== undefined) data[champ] = req.body[champ];
        });
        const paiement = new Paiement({
            ...data,
            _id: new mongoose.Types.ObjectId(),
            propriete: propriete._id,
            proprietaire: propriete.proprietaire,
            dureeMois,
            periodeDebut,
            periodeFin,
            adminEnregistreur: req.admin.id
        });
        await paiement.validate();

        // Réservation atomique de la période : si deux paiements arrivent en même temps,
        // un seul passe la condition "abonnement expiré" (et le début ne chevauche pas l'ancien abonnement)
        const limite = periodeDebut < maintenant ? periodeDebut : maintenant;
        const avant = await Propriete.findOneAndUpdate(
            {
                _id: propriete._id,
                $or: [
                    { dateExpirationAbonnement: null },
                    { dateExpirationAbonnement: { $lte: limite } }
                ]
            },
            { $set: { dateDebutAbonnement: periodeDebut, dateExpirationAbonnement: periodeFin, dernierPaiement: paiement._id } },
            { returnDocument: 'before' }
        );

        if (!avant) {
            const actuelle = await Propriete.findById(propriete._id);
            if (actuelle?.dateExpirationAbonnement > maintenant) throw erreurAbonnementEnCours(actuelle);
            throw erreur(
                400,
                `La date de début doit être postérieure ou égale à la fin du précédent abonnement (${formaterDate(actuelle.dateExpirationAbonnement)})`
            );
        }

        try {
            await paiement.save();
        } catch (error) {
            // Le paiement n'a pas pu être enregistré : on remet l'ancien abonnement de la propriété
            await Propriete.updateOne(
                { _id: propriete._id, dernierPaiement: paiement._id },
                {
                    $set: {
                        dateDebutAbonnement: avant.dateDebutAbonnement,
                        dateExpirationAbonnement: avant.dateExpirationAbonnement,
                        dernierPaiement: avant.dernierPaiement
                    }
                }
            ).catch(() => {});
            throw error;
        }

        await peuplerDocumentPaiement(paiement);
        return res.status(201).json({ success: true, message: 'Paiement enregistré avec succès', paiement });
    } catch (error) {
        return repondreErreur(error, res);
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
        const paiements = await peuplerRequetePaiement(Paiement.find(filtre).sort({ createdAt: -1 }));
        return res.status(200).json({ success: true, total: paiements.length, paiements });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.getById = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await peuplerRequetePaiement(Paiement.findById(req.params.id));
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }
        return res.status(200).json({ success: true, paiement });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Modifier un paiement.
// montant, devise, modePaiement, description : toujours modifiables.
// dureeMois, periodeDebut : seulement sur le paiement qui porte l'abonnement actuel de la propriété
// (le plus récent) ; la propriété est alors mise à jour avec la nouvelle période.
// La propriété d'un paiement ne peut pas être changée : supprimer le paiement et en enregistrer un nouveau.
exports.modifier = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await Paiement.findById(req.params.id);
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }

        if (req.body.propriete !== undefined && String(req.body.propriete) !== String(paiement.propriete)) {
            throw erreur(400, 'La propriété d\'un paiement ne peut pas être changée : supprimez ce paiement et enregistrez-en un nouveau');
        }

        CHAMPS_MODIFIABLES.forEach((champ) => {
            if (req.body[champ] !== undefined) paiement[champ] = req.body[champ];
        });

        const changePeriode = req.body.dureeMois !== undefined || req.body.periodeDebut !== undefined;
        if (!changePeriode) {
            await paiement.save();
            await peuplerDocumentPaiement(paiement);
            return res.status(200).json({ success: true, message: 'Paiement modifié avec succès', paiement });
        }

        const propriete = await Propriete.findById(paiement.propriete);
        if (!propriete || String(propriete.dernierPaiement) !== String(paiement._id)) {
            throw erreur(400, 'Seule la période du paiement le plus récent de la propriété peut être modifiée');
        }

        const dureeMois = req.body.dureeMois !== undefined ? lireDuree(req.body.dureeMois) : paiement.dureeMois;
        const periodeDebut = lireDateDebut(req.body.periodeDebut, paiement.periodeDebut);
        const periodeFin = ajouterMois(periodeDebut, dureeMois);

        const precedent = await Paiement.findOne({ propriete: paiement.propriete, _id: { $ne: paiement._id } })
            .sort({ periodeFin: -1 })
            .select('periodeFin');
        if (precedent && periodeDebut < precedent.periodeFin) {
            throw erreur(
                400,
                `La date de début doit être postérieure ou égale à la fin du précédent abonnement (${formaterDate(precedent.periodeFin)})`
            );
        }

        paiement.dureeMois = dureeMois;
        paiement.periodeDebut = periodeDebut;
        paiement.periodeFin = periodeFin;
        await paiement.save();

        await Propriete.updateOne(
            { _id: paiement.propriete, dernierPaiement: paiement._id },
            { $set: { dateDebutAbonnement: periodeDebut, dateExpirationAbonnement: periodeFin } }
        );

        await peuplerDocumentPaiement(paiement);
        return res.status(200).json({ success: true, message: 'Paiement modifié avec succès', paiement });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer un paiement. S'il portait l'abonnement actuel de la propriété,
// celle-ci reprend la période du paiement précédent (ou n'a plus d'abonnement).
exports.supprimer = async (req, res) => {
    try {
        if (!verifierIdentifiant(req.params.id, res)) return;
        const paiement = await Paiement.findByIdAndDelete(req.params.id);
        if (!paiement) {
            return res.status(404).json({ success: false, message: 'Paiement introuvable' });
        }

        const precedent = await Paiement.findOne({ propriete: paiement.propriete }).sort({ periodeFin: -1 });
        await Propriete.updateOne(
            { _id: paiement.propriete, dernierPaiement: paiement._id },
            {
                $set: {
                    dernierPaiement: precedent ? precedent._id : null,
                    dateDebutAbonnement: precedent ? precedent.periodeDebut : null,
                    dateExpirationAbonnement: precedent ? precedent.periodeFin : null
                }
            }
        );

        return res.status(200).json({ success: true, message: 'Paiement supprimé avec succès' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
