const mongoose = require('mongoose');
const Affectation = require('../models/affectation');
const Propriete = require('../models/propriete');
require('../models/proprietaire'); // pour afficher le propriétaire de la propriété
const Gardien = require('../models/gardien');
const Administrateur = require('../models/admin');
const { ajouterDuree, formaterDate } = require('../utils/dates');
const { normaliserHeure, normaliserJours, horairesSeChevauchent } = require('../utils/horaires');

// Champs renvoyés dans une affectation (avec les photos du gardien et de la propriété)
const CHAMPS_GARDIEN = 'matricule nom postnom prenom sexe photoProfil telephonePrincipal telephoneSecondaire statut';
const CHAMPS_PROPRIETE = 'nomReference typePropriete commune quartier avenue numero photos proprietaire dateDebutAbonnement dateExpirationAbonnement';
const CHAMPS_PROPRIETAIRE = 'nom postnom prenom telephone email photo';
const CHAMPS_GARDIEN_COURT = 'matricule nom postnom prenom photoProfil';

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

// Affectation liée (remplacée / remplaçante) : seulement le gardien et la période
const lienAffectation = (path) => ({
    path,
    select: 'gardien role dateDebut dateFin',
    populate: { path: 'gardien', select: CHAMPS_GARDIEN_COURT }
});

const peupler = (cible) => cible.populate([
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE, populate: { path: 'proprietaire', select: CHAMPS_PROPRIETAIRE } },
    { path: 'adminEnregistreur', select: '-password' },
    { path: 'retirePar', select: '-password' },
    lienAffectation('remplace'),
    lienAffectation('remplacePar')
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

const lireRole = (valeur) => {
    const role = String(valeur).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (!Affectation.ROLES.includes(role)) throw erreur(400, `Rôle invalide : ${Affectation.ROLES.join(', ')}`);
    return role;
};

const lireHeure = (valeur, libelle) => {
    const heure = normaliserHeure(valeur ?? '');
    if (!heure) throw erreur(400, `${libelle} invalide (format HH:mm, ex : 18:00)`);
    return heure;
};

const lireJours = (valeur) => {
    const jours = normaliserJours(valeur ?? '');
    if (!jours) throw erreur(400, 'Jours de service invalides : lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche');
    return jours;
};

const lireDateDebut = (valeur, parDefaut) => {
    if (valeur === undefined || valeur === '' || valeur === null) return parDefaut;
    const date = new Date(valeur);
    if (Number.isNaN(date.getTime())) throw erreur(400, 'Date de début invalide');
    return date;
};

const lireMotif = (valeur) => (valeur === undefined || valeur === null ? '' : String(valeur).trim());

// Affectations dont la période chevauche [debut, fin[
const chevauche = (debut, fin) => ({ dateDebut: { $lt: fin }, dateFin: { $gt: debut } });

// Un gardien ne peut pas avoir deux services qui se croisent (mêmes dates, mêmes jours et mêmes heures),
// sur la même propriété ou sur une autre. Il peut par exemple garder A le jour et B la nuit.
const verifierGardienDisponible = async (gardienId, service, exclureIds = []) => {
    const autres = await Affectation.find({
        gardien: gardienId,
        _id: { $nin: exclureIds },
        ...chevauche(service.dateDebut, service.dateFin)
    }).populate('propriete', 'nomReference');

    const conflit = autres.find((autre) => horairesSeChevauchent(service, autre));
    if (conflit) {
        const horaire = conflit.heureDebut ? ` de ${conflit.heureDebut} à ${conflit.heureFin}` : '';
        throw erreur(
            409,
            `Ce gardien est déjà affecté à « ${conflit.propriete?.nomReference || 'une propriété'} »${horaire} du ${formaterDate(conflit.dateDebut)} au ${formaterDate(conflit.dateFin)}`,
            { affectationEnConflit: conflit._id }
        );
    }
};

// Les autres gardiens principaux de la propriété sur la même période deviennent remplaçants
const retirerAutresPrincipaux = (affectation) => Affectation.updateMany(
    {
        propriete: affectation.propriete,
        _id: { $ne: affectation._id },
        role: 'principal',
        ...chevauche(affectation.dateDebut, affectation.dateFin)
    },
    { $set: { role: 'remplacant' } }
);

const verifierAdmin = async (req) => {
    if (!mongoose.Types.ObjectId.isValid(req.admin.id) || !(await Administrateur.exists({ _id: req.admin.id }))) {
        throw erreur(401, 'Administrateur introuvable');
    }
};

const trouverAffectation = async (id) => {
    verifierIdentifiant(id);
    const affectation = await Affectation.findById(id);
    if (!affectation) throw erreur(404, 'Affectation introuvable');
    return affectation;
};

// Met fin à une affectation maintenant. Une affectation "a venir" est annulée (sa période devient vide).
const cloturer = (affectation, { motif, adminId, remplacePar = null }) => {
    const maintenant = new Date();
    if (affectation.dateDebut > maintenant) affectation.dateDebut = maintenant;
    affectation.dateFin = maintenant;
    affectation.retireLe = maintenant;
    affectation.motifRetrait = motif;
    affectation.retirePar = adminId;
    affectation.remplacePar = remplacePar;
};

// Affecter un gardien à une propriété (JSON)
// Body : propriete, gardien, duree, heureDebut, heureFin,
//        [uniteDuree = "mois"], [dateDebut = aujourd'hui], [joursService = tous les jours], [role], [description]
exports.ajouter = async (req, res) => {
    try {
        const { propriete: proprieteId, gardien: gardienId } = req.body;
        const manquants = ['propriete', 'gardien', 'duree', 'heureDebut', 'heureFin']
            .filter((champ) => req.body[champ] === undefined || req.body[champ] === '');
        if (manquants.length) throw erreur(400, 'Champs obligatoires manquants : ' + manquants.join(', '));
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
        const service = {
            dateDebut,
            dateFin,
            heureDebut: lireHeure(req.body.heureDebut, 'Heure de début'),
            heureFin: lireHeure(req.body.heureFin, 'Heure de fin'),
            joursService: req.body.joursService !== undefined ? lireJours(req.body.joursService) : undefined
        };

        await verifierAdmin(req);
        const [propriete, gardien] = await Promise.all([
            Propriete.exists({ _id: proprieteId }),
            Gardien.exists({ _id: gardienId })
        ]);
        if (!propriete) throw erreur(404, 'Propriété introuvable');
        if (!gardien) throw erreur(404, 'Gardien introuvable');

        await verifierGardienDisponible(gardienId, service);

        // Sans choix de l'admin : principal s'il n'y a pas encore de principal sur la période, sinon remplaçant
        const role = req.body.role !== undefined
            ? lireRole(req.body.role)
            : (await Affectation.exists({ propriete: proprieteId, role: 'principal', ...chevauche(dateDebut, dateFin) }))
                ? 'remplacant'
                : 'principal';

        const affectation = await Affectation.create({
            ...service,
            propriete: proprieteId,
            gardien: gardienId,
            role,
            duree,
            uniteDuree,
            description: req.body.description ?? '',
            adminEnregistreur: req.admin.id
        });
        if (role === 'principal') await retirerAutresPrincipaux(affectation);

        await peupler(affectation);
        return res.status(201).json({ success: true, message: 'Gardien affecté avec succès', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Liste / historique des affectations.
// Filtres (query) : propriete, gardien, statut ("en cours" | "expiree" | "a venir"), role ("principal" | "remplacant")
// Tri : principal d'abord puis les plus récentes ; avec ?tri=recent : uniquement les plus récentes (historique)
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
        if (req.query.role !== undefined) filtre.role = lireRole(req.query.role);

        const tri = req.query.tri === 'recent' ? { dateDebut: -1, createdAt: -1 } : { role: 1, dateDebut: -1 };
        const affectations = await peupler(Affectation.find(filtre).sort(tri));
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

// Modifier une affectation non expirée (JSON) :
// role, heureDebut, heureFin, joursService, duree, uniteDuree, dateDebut, description.
// Le gardien et la propriété ne changent pas : utiliser "remplacer" pour changer de gardien.
exports.modifier = async (req, res) => {
    try {
        const affectation = await trouverAffectation(req.params.id);
        if (affectation.statut === 'expiree') {
            throw erreur(400, 'Cette affectation est expirée : elle fait partie de l\'historique et ne peut plus être modifiée');
        }
        if (req.body.gardien !== undefined && String(req.body.gardien) !== String(affectation.gardien)) {
            throw erreur(400, 'Pour changer de gardien, utilisez « Remplacer le gardien »');
        }
        if (req.body.propriete !== undefined && String(req.body.propriete) !== String(affectation.propriete)) {
            throw erreur(400, 'La propriété ne peut pas être changée : retirez le gardien et créez une nouvelle affectation');
        }

        if (req.body.description !== undefined) affectation.description = req.body.description;
        if (req.body.role !== undefined) affectation.role = lireRole(req.body.role);

        const changeService = ['duree', 'uniteDuree', 'dateDebut', 'heureDebut', 'heureFin', 'joursService']
            .some((champ) => req.body[champ] !== undefined);
        if (changeService) {
            if (req.body.heureDebut !== undefined) affectation.heureDebut = lireHeure(req.body.heureDebut, 'Heure de début');
            if (req.body.heureFin !== undefined) affectation.heureFin = lireHeure(req.body.heureFin, 'Heure de fin');
            if (req.body.joursService !== undefined) affectation.joursService = lireJours(req.body.joursService);

            const changePeriode = ['duree', 'uniteDuree', 'dateDebut'].some((champ) => req.body[champ] !== undefined);
            if (changePeriode) {
                affectation.duree = req.body.duree !== undefined ? lireDuree(req.body.duree) : affectation.duree;
                affectation.uniteDuree = req.body.uniteDuree !== undefined ? lireUnite(req.body.uniteDuree) : affectation.uniteDuree;
                affectation.dateDebut = lireDateDebut(req.body.dateDebut, affectation.dateDebut);
                affectation.dateFin = ajouterDuree(affectation.dateDebut, affectation.duree, affectation.uniteDuree);
                if (affectation.dateFin <= new Date()) {
                    throw erreur(400, 'Cette affectation serait déjà expirée : vérifiez la date de début et la durée');
                }
            }
            await verifierGardienDisponible(affectation.gardien, affectation, [affectation._id]);
        }

        await affectation.save();
        if (affectation.role === 'principal') await retirerAutresPrincipaux(affectation);

        await peupler(affectation);
        return res.status(200).json({ success: true, message: 'Affectation modifiée avec succès', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Définir ce gardien comme gardien principal de la propriété (les autres principaux deviennent remplaçants)
exports.definirPrincipal = async (req, res) => {
    try {
        const affectation = await trouverAffectation(req.params.id);
        if (affectation.statut === 'expiree') {
            throw erreur(400, 'Cette affectation est expirée : elle ne peut pas devenir principale');
        }

        affectation.role = 'principal';
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

// Retirer un gardien de la propriété maintenant (JSON, body : [motif]).
// L'affectation passe en "expiree" et reste dans l'historique.
exports.retirer = async (req, res) => {
    try {
        const affectation = await trouverAffectation(req.params.id);
        if (affectation.statut === 'expiree') throw erreur(400, 'Ce gardien n\'est déjà plus affecté (affectation expirée)');
        await verifierAdmin(req);

        cloturer(affectation, { motif: lireMotif(req.body?.motif), adminId: req.admin.id });
        await affectation.save();

        await peupler(affectation);
        return res.status(200).json({ success: true, message: 'Gardien retiré de la propriété', affectation });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Remplacer le gardien d'une affectation (JSON, body : gardien, [motif]).
// L'ancien gardien est retiré maintenant ; le nouveau reprend le même rôle, les mêmes horaires
// et les mêmes jours jusqu'à la date de fin prévue.
exports.remplacer = async (req, res) => {
    try {
        const ancienne = await trouverAffectation(req.params.id);
        if (ancienne.statut === 'expiree') throw erreur(400, 'Cette affectation est expirée : il n\'y a plus de gardien à remplacer');

        const gardienId = req.body?.gardien;
        if (!gardienId) throw erreur(400, 'Le nouveau gardien est obligatoire');
        verifierIdentifiant(gardienId, 'Identifiant de gardien');
        if (String(gardienId) === String(ancienne.gardien)) throw erreur(400, 'Le nouveau gardien doit être différent de l\'actuel');

        await verifierAdmin(req);
        const nouveauGardien = await Gardien.findById(gardienId).select('nom postnom prenom');
        if (!nouveauGardien) throw erreur(404, 'Gardien introuvable');

        const maintenant = new Date();
        const service = {
            dateDebut: ancienne.statut === 'a venir' ? ancienne.dateDebut : maintenant,
            dateFin: ancienne.dateFin,
            heureDebut: ancienne.heureDebut,
            heureFin: ancienne.heureFin,
            joursService: ancienne.joursService
        };
        await verifierGardienDisponible(gardienId, service);

        const nouvelle = await Affectation.create({
            ...service,
            propriete: ancienne.propriete,
            gardien: gardienId,
            role: ancienne.role,
            duree: ancienne.duree,
            uniteDuree: ancienne.uniteDuree,
            description: ancienne.description,
            remplace: ancienne._id,
            adminEnregistreur: req.admin.id
        });

        const motif = lireMotif(req.body.motif) || `Remplacé par ${nomGardien(nouveauGardien)}`;
        cloturer(ancienne, { motif, adminId: req.admin.id, remplacePar: nouvelle._id });
        try {
            await ancienne.save();
        } catch (error) {
            await Affectation.deleteOne({ _id: nouvelle._id }).catch(() => {});
            throw error;
        }

        await peupler(nouvelle);
        return res.status(201).json({
            success: true,
            message: `${nomGardien(nouveauGardien)} remplace désormais l'ancien gardien`,
            affectation: nouvelle,
            ancienneAffectation: ancienne._id
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer une affectation (erreur de saisie). Pour garder l'historique, préférer "retirer".
exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const affectation = await Affectation.findByIdAndDelete(req.params.id);
        if (!affectation) throw erreur(404, 'Affectation introuvable');

        // Les liens de remplacement qui pointaient vers elle sont coupés
        await Affectation.updateMany({ remplace: affectation._id }, { $set: { remplace: null } });
        await Affectation.updateMany({ remplacePar: affectation._id }, { $set: { remplacePar: null } });

        return res.status(200).json({ success: true, message: 'Affectation supprimée avec succès' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
