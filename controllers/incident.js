const mongoose = require('mongoose');
const Incident = require('../models/incident');
const Propriete = require('../models/propriete');
const Affectation = require('../models/affectation');
const Administrateur = require('../models/admin');
require('../models/gardien');
require('../models/proprietaire');
const { supprimerDeR2 } = require('../middleware/upload');
const { jourLocal, instantLocal, decalerJour } = require('../utils/horaires');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];
const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE', 'LOCATAIRE'];

const CHAMPS_GARDIEN = 'matricule nom postnom prenom photoProfil telephonePrincipal';
const CHAMPS_PROPRIETE = 'nomReference commune quartier avenue numero coordonnees photos proprietaire';

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

const estAdmin = (req) => ROLES_ADMIN.includes(req.admin.role);
const estGardien = (req) => req.admin.role === 'GARDIEN';
const estProprietaire = (req) => ROLES_PROPRIETAIRE.includes(req.admin.role);

const peupler = (cible) => cible.populate([
    { path: 'signalePar', select: '-password' },
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE, populate: { path: 'proprietaire', select: 'nom postnom prenom telephone' } },
    { path: 'traitePar', select: '-password' }
]);

// Lit une valeur d'une liste (sans tenir compte des accents, de la casse ni des espaces)
const lireValeur = (valeur, liste, libelle) => {
    const cle = String(valeur ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (!liste[cle]) throw erreur(400, `${libelle} invalide : ${Object.keys(liste).join(', ')}`);
    return cle;
};

// Nombre facultatif envoyé en multipart (texte) : '' ou absent -> null
const lireNombre = (valeur, libelle) => {
    if (valeur === undefined || valeur === null || valeur === '') return null;
    const nombre = Number(valeur);
    if (!Number.isFinite(nombre)) throw erreur(400, `${libelle} invalide`);
    return nombre;
};

const lirePosition = (body) => {
    const lat = lireNombre(body.lat, 'Latitude');
    const lng = lireNombre(body.lng, 'Longitude');
    if ((lat === null) !== (lng === null)) throw erreur(400, 'La position GPS demande la latitude et la longitude');
    return { lat, lng, precision: lat === null ? null : lireNombre(body.precision, 'Précision GPS') };
};

// Date et heure de l'incident : maintenant par défaut, jamais dans le futur
const lireDateIncident = (valeur) => {
    if (valeur === undefined || valeur === '') return new Date();
    const date = new Date(valeur);
    if (Number.isNaN(date.getTime())) throw erreur(400, 'Date de l\'incident invalide');
    if (date.getTime() > Date.now() + 5 * 60000) throw erreur(400, 'La date de l\'incident ne peut pas être dans le futur');
    return date;
};

// Période "du" / "au" en jours locaux (AAAA-MM-JJ), les deux inclus, sur la date de l'incident
const filtrePeriode = (query) => {
    if (query.du === undefined && query.au === undefined) return {};
    const format = /^\d{4}-\d{2}-\d{2}$/;
    const au = query.au ?? jourLocal(new Date());
    const du = query.du ?? '2000-01-01';
    if (!format.test(du) || !format.test(au)) throw erreur(400, 'Dates "du" et "au" au format AAAA-MM-JJ');
    return { dateIncident: { $gte: instantLocal(du), $lt: instantLocal(decalerJour(au, 1)) } };
};

// Filtres communs aux listes. Query : type, gravite, statut, propriete, gardien, du, au
const lireFiltres = (query) => {
    const filtre = filtrePeriode(query);
    for (const champ of ['propriete', 'gardien']) {
        if (query[champ] !== undefined) {
            verifierIdentifiant(query[champ], `Identifiant ${champ}`);
            filtre[champ] = query[champ];
        }
    }
    if (query.type !== undefined) filtre.type = lireValeur(query.type, Incident.TYPES, 'Type');
    if (query.gravite !== undefined) filtre.gravite = lireValeur(query.gravite, Incident.GRAVITES, 'Gravité');
    if (query.statut !== undefined) filtre.statut = lireValeur(query.statut, Incident.STATUTS, 'Statut');
    return filtre;
};

const affectationEnCours = (gardienId, proprieteId) => Affectation.exists({
    gardien: gardienId,
    propriete: proprieteId,
    ...Affectation.filtreStatut('en cours')
});

// Propriété et gardien concernés, selon qui signale
const trouverConcernes = async (req) => {
    const { propriete: proprieteId, gardien: gardienId } = req.body;

    // Gardien : il est le gardien concerné. Sans propriété précisée, on prend celle de son affectation en cours
    if (estGardien(req)) {
        if (proprieteId) {
            verifierIdentifiant(proprieteId, 'Identifiant de propriété');
            if (!(await affectationEnCours(req.admin.id, proprieteId))) {
                throw erreur(403, 'Vous n\'êtes pas affecté à cette propriété');
            }
            return { propriete: proprieteId, gardien: req.admin.id };
        }
        const affectations = await Affectation.find({ gardien: req.admin.id, ...Affectation.filtreStatut('en cours') }).select('propriete');
        const proprietes = [...new Set(affectations.map((a) => String(a.propriete)))];
        if (proprietes.length === 0) throw erreur(400, 'Aucune affectation en cours : précisez la propriété concernée');
        if (proprietes.length > 1) throw erreur(400, 'Vous êtes affecté à plusieurs propriétés : précisez la propriété concernée');
        return { propriete: proprietes[0], gardien: req.admin.id };
    }

    // Propriétaire ou admin : propriété obligatoire, gardien facultatif
    if (!proprieteId) throw erreur(400, 'La propriété concernée est obligatoire');
    verifierIdentifiant(proprieteId, 'Identifiant de propriété');
    const propriete = await Propriete.findById(proprieteId).select('proprietaire');
    if (!propriete) throw erreur(404, 'Propriété introuvable');
    if (estProprietaire(req) && String(propriete.proprietaire) !== String(req.admin.id)) {
        throw erreur(403, 'Cette propriété ne vous appartient pas');
    }

    if (gardienId === undefined || gardienId === '') return { propriete: proprieteId, gardien: null };
    verifierIdentifiant(gardienId, 'Identifiant de gardien');
    if (!(await Affectation.exists({ gardien: gardienId, propriete: proprieteId }))) {
        throw erreur(400, 'Ce gardien n\'est pas affecté à cette propriété');
    }
    return { propriete: proprieteId, gardien: gardienId };
};

// L'admin, l'auteur du signalement, ou le propriétaire de la propriété concernée
const peutVoir = (req, incident) => {
    if (estAdmin(req)) return true;
    const moi = String(req.admin.id);
    if (String(incident.signalePar?._id ?? incident.signalePar) === moi) return true;
    return estProprietaire(req) && String(incident.propriete?.proprietaire?._id ?? incident.propriete?.proprietaire) === moi;
};

// Listes pour les selects : [{ valeur, libelle }]
exports.options = (req, res) => {
    const enListe = (objet) => Object.entries(objet).map(([valeur, libelle]) => ({ valeur, libelle }));
    res.status(200).json({
        success: true,
        types: enListe(Incident.TYPES),
        gravites: enListe(Incident.GRAVITES),
        statuts: enListe(Incident.STATUTS),
        graviteParDefaut: Incident.GRAVITE_PAR_DEFAUT
    });
};

// Signaler un incident (gardien, propriétaire ou admin) — multipart/form-data
// Body : type, description, [dateIncident], [lat, lng, precision], [gravite], [propriete], [gardien]
// Fichiers : "photos" (0 à 5 images), "videos" (0 à 2 vidéos)
exports.signaler = async (req, res) => {
    const fichiers = [...(req.fichiers?.photos ?? []), ...(req.fichiers?.videos ?? [])];
    const annulerFichiers = () => supprimerDeR2(fichiers).catch(() => {});

    try {
        let signaleParModele;
        if (estGardien(req)) signaleParModele = 'Gardien';
        else if (estProprietaire(req)) signaleParModele = 'Proprietaire';
        else if (estAdmin(req)) signaleParModele = 'Administrateur';
        else throw erreur(403, 'Accès refusé');

        if (!req.body.type || !req.body.description) {
            throw erreur(400, 'Le type et la description de l\'incident sont obligatoires');
        }
        const type = lireValeur(req.body.type, Incident.TYPES, 'Type');
        const gravite = req.body.gravite
            ? lireValeur(req.body.gravite, Incident.GRAVITES, 'Gravité')
            : Incident.GRAVITE_PAR_DEFAUT[type];
        const concernes = await trouverConcernes(req);

        const incident = await Incident.create({
            type,
            description: req.body.description,
            dateIncident: lireDateIncident(req.body.dateIncident),
            position: lirePosition(req.body),
            photos: req.fichiers?.photos ?? [],
            videos: req.fichiers?.videos ?? [],
            signalePar: req.admin.id,
            signaleParModele,
            ...concernes,
            gravite
        });

        await peupler(incident);
        return res.status(201).json({ success: true, message: 'Incident signalé', incident });
    } catch (error) {
        annulerFichiers();
        return repondreErreur(error, res);
    }
};

// Incidents de l'utilisateur connecté. Query : type, gravite, statut, propriete, du, au
// Gardien : ceux qu'il a signalés ou qui le concernent. Propriétaire : ceux de ses propriétés
exports.mesIncidents = async (req, res) => {
    try {
        const filtre = lireFiltres(req.query);
        delete filtre.gardien;

        if (estGardien(req)) {
            filtre.$or = [{ signalePar: req.admin.id }, { gardien: req.admin.id }];
        } else if (estProprietaire(req)) {
            const proprietes = await Propriete.find({ proprietaire: req.admin.id }).distinct('_id');
            if (filtre.propriete && !proprietes.some((id) => String(id) === String(filtre.propriete))) {
                throw erreur(403, 'Cette propriété ne vous appartient pas');
            }
            if (!filtre.propriete) filtre.propriete = { $in: proprietes };
        } else {
            filtre.signalePar = req.admin.id;
        }

        const incidents = await peupler(Incident.find(filtre).sort({ dateIncident: -1 }));
        return res.status(200).json({ success: true, total: incidents.length, incidents });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Entreprise (admin) ----------

// Tous les incidents. Query : type, gravite, statut, propriete, gardien, du, au
exports.getAll = async (req, res) => {
    try {
        const filtre = lireFiltres(req.query);
        const [incidents, nonTraites] = await Promise.all([
            peupler(Incident.find(filtre).sort({ dateIncident: -1 })),
            Incident.countDocuments({ statut: 'nouveau' })
        ]);
        return res.status(200).json({ success: true, total: incidents.length, nonTraites, incidents });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.getById = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const incident = await peupler(Incident.findById(req.params.id));
        if (!incident) throw erreur(404, 'Incident introuvable');
        if (!peutVoir(req, incident)) throw erreur(403, 'Accès refusé');
        return res.status(200).json({ success: true, incident });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Traitement par l'entreprise (admin). Body : [statut], [gravite], [commentaireAdmin]
exports.traiter = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        if (!mongoose.Types.ObjectId.isValid(req.admin.id) || !(await Administrateur.exists({ _id: req.admin.id }))) {
            throw erreur(401, 'Administrateur introuvable');
        }
        const { statut, gravite, commentaireAdmin } = req.body;
        if (statut === undefined && gravite === undefined && commentaireAdmin === undefined) {
            throw erreur(400, 'Rien à modifier : statut, gravite ou commentaireAdmin');
        }

        const incident = await Incident.findById(req.params.id);
        if (!incident) throw erreur(404, 'Incident introuvable');

        if (statut !== undefined) {
            incident.statut = lireValeur(statut, Incident.STATUTS, 'Statut');
            incident.traitePar = incident.statut === 'nouveau' ? null : req.admin.id;
            incident.traiteLe = incident.statut === 'nouveau' ? null : new Date();
        }
        if (gravite !== undefined) incident.gravite = lireValeur(gravite, Incident.GRAVITES, 'Gravité');
        if (commentaireAdmin !== undefined) incident.commentaireAdmin = commentaireAdmin;
        await incident.save();

        await peupler(incident);
        return res.status(200).json({ success: true, message: 'Incident mis à jour', incident });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer un incident et ses photos / vidéos (super admin)
exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const incident = await Incident.findByIdAndDelete(req.params.id);
        if (!incident) throw erreur(404, 'Incident introuvable');
        supprimerDeR2([...incident.photos, ...incident.videos]).catch(() => {});
        return res.status(200).json({ success: true, message: 'Incident supprimé' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
