const mongoose = require('mongoose');
const Affectation = require('../models/affectation');
const Propriete = require('../models/propriete');
const Gardien = require('../models/gardien');
const Administrateur = require('../models/admin');
const { ajouterDuree, formaterDate } = require('../utils/dates');

// Champs du gardien renvoyés dans une affectation (avec sa photo)
const CHAMPS_GARDIEN = 'matricule nom postnom prenom sexe photoProfil telephonePrincipal telephoneSecondaire statut';
// Champs de la propriété renvoyés dans une affectation (avec ses photos)
const CHAMPS_PROPRIETE = 'nomReference typePropriete commune quartier avenue numero photos proprietaire dateDebutAbonnement dateExpirationAbonnement';

const erreur = (statut, message, details) => Object.assign(new Error(message), { statut, details });

const repondreErreur = (error, res) => {
    if (error.statut) {
        return res.status(error.statut).json({ success: false, message: error.message, ...error.details });
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

const verifierIdentifiant = (id, libelle = 'Identifiant') => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw erreur(400, `${libelle} invalide`);
};

const peupler = (cible) => cible.populate([
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE },
    { path: 'adminEnregistreur', select: '-password' }
]);

const nomGardien = (gardien) => [gardien.prenom, gardien.nom, gardien.postnom].filter(Boolean).join(' ');

const lireDuree = (valeur) => {
    const duree = Number(valeur);
    if (valeur === undefined || valeur === '' || !Number.isInteger(duree) || duree < 1) {
        throw erreur(400, 'La durée doit être un nombre entier supérieur ou égal à 1');
    }
    return duree;
};

const lireUnite = (valeur) => {
    if (!Affectation.UNITES_DUREE.includes(valeur)) {
        throw erreur(400, `Unité de durée invalide : ${Affectation.UNITES_DUREE.join(', ')}`);
    }
    return valeur;
};

const lireDateDebut = (valeur, parDefaut) => {
    if (valeur === undefined || valeur === '' || valeur === null) return parDefaut;
    const date = new Date(valeur);
    if (Number.isNaN(date.getTime())) throw erreur(400, 'Date de début invalide');
    return date;
};

// "oui", "true", "1", true -> true ; "non", "false", "0", false -> false
const lireBooleen = (valeur, libelle) => {
    if (typeof valeur === 'boolean') return valeur;
    const v = String(valeur).toLowerCase().trim();
    if (['oui', 'true', '1'].includes(v)) return true;
    if (['non', 'false', '0'].includes(v)) return false;
    throw erreur(400, `${libelle} doit valoir true ou false`);
};

// Affectations dont la période chevauche [debut, fin[
const chevauche = (debut, fin) => ({ dateDebut: { $lt: fin }, dateFin: { $gt: debut } });

// Un gardien ne peut pas être affecté deux fois sur la même période (même propriété ou une autre)
const verifierGardienDisponible = async (gardienId, debut, fin, exclureId) => {
    const filtre = { gardien: gardienId, ...chevauche(debut, fin) };
    if (exclureId) filtre._id = { $ne: exclureId };

    const conflit = await Affectation.findOne(filtre).populate('propriete', 'nomReference');
    if (conflit) {
        throw erreur(
            409,
            `Ce gardien est déjà affecté à « ${conflit.propriete?.nomReference || 'une propriété'} » du ${formaterDate(conflit.dateDebut)} au ${formaterDate(conflit.dateFin)}`,
            { affectationEnConflit: conflit._id }
        );
    }
};

// Retire le rôle de principal aux autres gardiens de la propriété sur la même période
const retirerAutresPrincipaux = (affectation) => Affectation.updateMany(
    {
        propriete: affectation.propriete,
        _id: { $ne: affectation._id },
        estPrincipal: true,
        ...chevauche(affectation.dateDebut, affectation.dateFin)
    },
    { $set: { estPrincipal: false } }
);

const verifierAdmin = async (req) => {
    if (!mongoose.Types.ObjectId.isValid(req.admin.id) || !(await Administrateur.exists({ _id: req.admin.id }))) {
        throw erreur(401, 'Administrateur introuvable');
    }
};

// Affecter un gardien à une propriété (JSON)
// Body : propriete, gardien, duree, [uniteDuree = "mois"], [dateDebut = aujourd'hui], [estPrincipal], [description]
exports.ajouter = async (req, res) => {
    try {
        const { propriete: proprieteId, gardien: gardienId } = req.body;
        if (!proprieteId || !gardienId || req.body.duree === undefined) {
            throw erreur(400, 'La propriété, le gardien et la durée sont obligatoires');
        }
        verifierIdentifiant(proprieteId, 'Identifiant de propriété');
        verifierIdentifiant(gardienId, 'Identifiant de gardien');

        const maintenant = new Date();
        const duree = lireDuree(req.body.duree);
        const uniteDuree = lireUnite(req.body.uniteDuree ?? 'mois');
        const dateDebut = lireDateDebut(req.body.dateDebut, maintenant);
        const dateFin = ajouterDuree(dateDebut, duree, uniteDuree);
        if (dateFin <= maintenant) {
            throw erreur(400, 'Cette affectation serait déjà expirée : vérifiez la date de début et la durée');
        }

        await verifierAdmin(req);
        const [propriete, gardien] = await Promise.all([
            Propriete.exists({ _id: proprieteId }),
            Gardien.exists({ _id: gardienId })
        ]);
        if (!propriete) throw erreur(404, 'Propriété introuvable');
        if (!gardien) throw erreur(404, 'Gardien introuvable');

        await verifierGardienDisponible(gardienId, dateDebut, dateFin);

        // Sans choix de l'admin, le premier gardien affecté sur la période devient principal
        const estPrincipal = req.body.estPrincipal !== undefined
            ? lireBooleen(req.body.estPrincipal, 'estPrincipal')
            : !(await Affectation.exists({ propriete: proprieteId, ...chevauche(dateDebut, dateFin) }));

        const affectation = await Affectation.create({
            propriete: proprieteId,
            gardien: gardienId,
            estPrincipal,
            duree,
            uniteDuree,
            dateDebut,
            dateFin,
            description: req.body.description ?? '',
            adminEnregistreur: req.admin.id
        });
        if (estPrincipal) await retirerAutresPrincipaux(affectation);

        await peupler(affectation);
        return res.status(201).json({ success: true, message: 'Gardien affecté avec succès', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Liste des affectations. Filtres (query) : propriete, gardien, statut ("en cours" | "expiree" | "a venir"), estPrincipal
// Tri : principal d'abord, puis les plus récentes
exports.getAll = async (req, res) => {
    try {
        const filtre = {};
        for (const champ of ['propriete', 'gardien']) {
            if (req.query[champ] !== undefined) {
                verifierIdentifiant(req.query[champ], `Identifiant ${champ}`);
                filtre[champ] = req.query[champ];
            }
        }
        if (req.query.statut !== undefined) {
            const filtreStatut = Affectation.filtreStatut(req.query.statut);
            if (!filtreStatut) throw erreur(400, 'Statut invalide : en cours, expiree, a venir');
            Object.assign(filtre, filtreStatut);
        }
        if (req.query.estPrincipal !== undefined) {
            filtre.estPrincipal = lireBooleen(req.query.estPrincipal, 'estPrincipal');
        }

        const affectations = await peupler(Affectation.find(filtre).sort({ estPrincipal: -1, dateDebut: -1 }));
        return res.status(200).json({ success: true, total: affectations.length, affectations });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Affectations du gardien connecté (token GARDIEN)
exports.mesAffectations = async (req, res) => {
    try {
        if (req.admin.role !== 'GARDIEN') throw erreur(403, 'Réservé aux gardiens');
        const filtre = { gardien: req.admin.id };
        if (req.query.statut !== undefined) {
            const filtreStatut = Affectation.filtreStatut(req.query.statut);
            if (!filtreStatut) throw erreur(400, 'Statut invalide : en cours, expiree, a venir');
            Object.assign(filtre, filtreStatut);
        }
        const affectations = await peupler(Affectation.find(filtre).sort({ dateDebut: -1 }));
        return res.status(200).json({ success: true, total: affectations.length, affectations });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.getById = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await peupler(Affectation.findById(req.params.id));
        if (!affectation) throw erreur(404, 'Affectation introuvable');
        return res.status(200).json({ success: true, affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Modifier une affectation (JSON) : duree, uniteDuree, dateDebut, estPrincipal, description.
// La propriété et le gardien ne changent pas : supprimer l'affectation et en créer une nouvelle.
exports.modifier = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await Affectation.findById(req.params.id);
        if (!affectation) throw erreur(404, 'Affectation introuvable');

        for (const champ of ['propriete', 'gardien']) {
            if (req.body[champ] !== undefined && String(req.body[champ]) !== String(affectation[champ])) {
                throw erreur(400, `Le champ ${champ} ne peut pas être changé : supprimez cette affectation et créez-en une nouvelle`);
            }
        }

        if (req.body.description !== undefined) affectation.description = req.body.description;

        const changePeriode = ['duree', 'uniteDuree', 'dateDebut'].some((champ) => req.body[champ] !== undefined);
        if (changePeriode) {
            affectation.duree = req.body.duree !== undefined ? lireDuree(req.body.duree) : affectation.duree;
            affectation.uniteDuree = req.body.uniteDuree !== undefined ? lireUnite(req.body.uniteDuree) : affectation.uniteDuree;
            affectation.dateDebut = lireDateDebut(req.body.dateDebut, affectation.dateDebut);
            affectation.dateFin = ajouterDuree(affectation.dateDebut, affectation.duree, affectation.uniteDuree);
            affectation.termineeLe = null;
            await verifierGardienDisponible(affectation.gardien, affectation.dateDebut, affectation.dateFin, affectation._id);
        }

        if (req.body.estPrincipal !== undefined) {
            affectation.estPrincipal = lireBooleen(req.body.estPrincipal, 'estPrincipal');
        }

        await affectation.save();
        if (affectation.estPrincipal) await retirerAutresPrincipaux(affectation);

        await peupler(affectation);
        return res.status(200).json({ success: true, message: 'Affectation modifiée avec succès', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Définir ce gardien comme gardien principal de la propriété (les autres ne le sont plus sur la même période)
exports.definirPrincipal = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await Affectation.findById(req.params.id);
        if (!affectation) throw erreur(404, 'Affectation introuvable');
        if (affectation.statut === 'expiree') {
            throw erreur(400, 'Cette affectation est expirée : elle ne peut pas devenir principale');
        }

        affectation.estPrincipal = true;
        await affectation.save();
        await retirerAutresPrincipaux(affectation);

        await peupler(affectation);
        return res.status(200).json({
            success: true,
            message: `${nomGardien(affectation.gardien)} est maintenant le gardien principal`,
            affectation
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Mettre fin à une affectation en cours avant son terme (elle passe en "expiree")
exports.terminer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await Affectation.findById(req.params.id);
        if (!affectation) throw erreur(404, 'Affectation introuvable');
        if (affectation.statut === 'expiree') throw erreur(400, 'Cette affectation est déjà expirée');
        if (affectation.statut === 'a venir') {
            throw erreur(400, 'Cette affectation n\'a pas encore commencé : supprimez-la plutôt');
        }

        const maintenant = new Date();
        affectation.dateFin = maintenant;
        affectation.termineeLe = maintenant;
        await affectation.save();

        await peupler(affectation);
        return res.status(200).json({ success: true, message: 'Affectation terminée', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await Affectation.findByIdAndDelete(req.params.id);
        if (!affectation) throw erreur(404, 'Affectation introuvable');
        return res.status(200).json({ success: true, message: 'Affectation supprimée avec succès' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
