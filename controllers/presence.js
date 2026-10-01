const mongoose = require('mongoose');
const Presence = require('../models/presence');
const Affectation = require('../models/affectation');
require('../models/propriete');
require('../models/proprietaire'); // pour afficher la propriété et son propriétaire
const Gardien = require('../models/gardien');
const Administrateur = require('../models/admin');
const { jourLocal, instantLocal, decalerJour, heureLocale, servicePrevu } = require('../utils/horaires');

// Réglages (modifiables par variables d'environnement)
const AVANCE_MAX_MINUTES = Number(process.env.PRESENCE_AVANCE_MAX_MINUTES ?? 60); // pointage possible 1 h avant le début
const TOLERANCE_RETARD_MINUTES = Number(process.env.PRESENCE_TOLERANCE_RETARD_MINUTES ?? 15); // au-delà : "en retard"
const RAYON_ZONE_METRES = Number(process.env.PRESENCE_RAYON_ZONE_METRES ?? 200); // au-delà : "hors zone"
const PERIODE_MAX_JOURS = 366;

const CHAMPS_GARDIEN = 'matricule nom postnom prenom photoProfil telephonePrincipal statut';
const CHAMPS_PROPRIETE = 'nomReference commune quartier avenue numero photos coordonnees proprietaire';
const CHAMPS_AFFECTATION = 'role heureDebut heureFin joursService dateDebut dateFin';

const erreur = (statut, message, details) => Object.assign(new Error(message), { statut, details });

const repondreErreur = (error, res) => {
    if (error.statut) {
        return res.status(error.statut).json({ success: false, message: error.message, ...error.details });
    }
    if (error.code === 11000) {
        return res.status(409).json({ success: false, message: 'Ce service a déjà été pointé' });
    }
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

const verifierAdmin = async (req) => {
    if (!mongoose.Types.ObjectId.isValid(req.admin.id) || !(await Administrateur.exists({ _id: req.admin.id }))) {
        throw erreur(401, 'Administrateur introuvable');
    }
};

const peupler = (cible) => cible.populate([
    { path: 'gardien', select: CHAMPS_GARDIEN },
    { path: 'propriete', select: CHAMPS_PROPRIETE, populate: { path: 'proprietaire', select: 'nom postnom prenom telephone' } },
    { path: 'affectation', select: CHAMPS_AFFECTATION },
    { path: 'cloturePar', select: '-password' }
]);

const minutesEntre = (debut, fin) => Math.round((fin.getTime() - debut.getTime()) / 60000);

// Distance en mètres entre deux points GPS (formule de haversine)
const distanceMetres = (a, b) => {
    const rad = (degres) => (degres * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
};

const lirePosition = (body) => {
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (body?.lat === undefined || body?.lng === undefined || body.lat === '' || body.lng === ''
        || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw erreur(400, 'Position GPS obligatoire : lat et lng');
    }
    const precision = Number(body.precision);
    return { lat, lng, precision: Number.isFinite(precision) && precision >= 0 ? precision : null };
};

// Position + distance à la propriété (hors zone si trop loin ; inconnu si la propriété n'a pas de coordonnées)
const positionPres = (position, propriete) => {
    const coordonnees = propriete?.coordonnees;
    if (coordonnees?.lat == null || coordonnees?.lng == null) return { ...position, distanceMetres: null, horsZone: false };
    const distance = distanceMetres(position, coordonnees);
    return { ...position, distanceMetres: distance, horsZone: distance > RAYON_ZONE_METRES };
};

// Période "du" / "au" en jours locaux (AAAA-MM-JJ), les deux inclus. Par défaut : les 30 derniers jours.
const lirePeriode = (query) => {
    const format = /^\d{4}-\d{2}-\d{2}$/;
    const aujourdHui = jourLocal(new Date());
    const au = query.au ?? aujourdHui;
    const du = query.du ?? decalerJour(au, -29);
    if (!format.test(du) || !format.test(au)) throw erreur(400, 'Dates "du" et "au" au format AAAA-MM-JJ');
    if (du > au) throw erreur(400, 'La date "du" doit être avant la date "au"');
    const nombreJours = minutesEntre(new Date(`${du}T00:00:00Z`), new Date(`${au}T00:00:00Z`)) / 1440 + 1;
    if (nombreJours > PERIODE_MAX_JOURS) throw erreur(400, `Période limitée à ${PERIODE_MAX_JOURS} jours`);
    return { du, au, debut: instantLocal(du), fin: instantLocal(decalerJour(au, 1)) };
};

const filtreIdentifiants = (query) => {
    const filtre = {};
    for (const champ of ['gardien', 'propriete', 'affectation']) {
        if (query[champ] !== undefined) {
            verifierIdentifiant(query[champ], `Identifiant ${champ}`);
            filtre[champ] = new mongoose.Types.ObjectId(String(query[champ]));
        }
    }
    return filtre;
};

// Services prévus par les affectations entre deux jours locaux (inclus)
const servicesPrevus = async ({ du, au, gardien, propriete, affectation }) => {
    const filtre = {
        dateDebut: { $lt: instantLocal(decalerJour(au, 2)) },
        dateFin: { $gt: instantLocal(decalerJour(du, -1)) }
    };
    if (gardien) filtre.gardien = gardien;
    if (propriete) filtre.propriete = propriete;
    if (affectation) filtre._id = affectation;

    const affectations = await Affectation.find(filtre)
        .populate('gardien', CHAMPS_GARDIEN)
        .populate('propriete', 'nomReference commune quartier avenue photos');

    const prevus = [];
    for (const aff of affectations) {
        for (let jour = du; jour <= au; jour = decalerJour(jour, 1)) {
            const service = servicePrevu(aff, jour);
            if (service) prevus.push({ ...service, affectation: aff });
        }
    }
    return prevus;
};

// Services prévus qui n'ont jamais été pointés.
// "absent" : le service est terminé sans pointage ; "pas encore arrive" : le service a commencé
// depuis plus que la tolérance de retard et le gardien n'a pas pointé.
const calculerAbsences = async (criteres) => {
    const maintenant = new Date();
    const prevus = await servicesPrevus(criteres);
    const pointes = await Presence.find({
        affectation: { $in: [...new Set(prevus.map((p) => p.affectation._id))] },
        jourService: { $gte: criteres.du, $lte: criteres.au }
    }).select('affectation jourService');
    const dejaPointes = new Set(pointes.map((p) => `${p.affectation}|${p.jourService}`));

    return prevus
        .filter((p) => !dejaPointes.has(`${p.affectation._id}|${p.jourService}`))
        // Un service déjà terminé quand le gardien a été affecté n'est pas une absence
        .filter((p) => !p.affectation.createdAt || p.finPrevue > p.affectation.createdAt)
        .filter((p) => p.debutPrevu.getTime() + TOLERANCE_RETARD_MINUTES * 60000 < maintenant.getTime())
        .map((p) => ({
            etat: p.finPrevue <= maintenant ? 'absent' : 'pas encore arrive',
            jourService: p.jourService,
            debutPrevu: p.debutPrevu,
            finPrevue: p.finPrevue,
            role: p.affectation.role,
            affectation: p.affectation._id,
            gardien: p.affectation.gardien,
            propriete: p.affectation.propriete
        }))
        .sort((a, b) => b.debutPrevu - a.debutPrevu);
};

// Services oubliés (départ jamais pointé) : clôturés automatiquement à l'heure de fin prévue
const cloturerOublies = async (filtre) => {
    const oublies = await Presence.find({ ...filtre, ...Presence.filtreStatut('non cloture') });
    for (const service of oublies) {
        const depart = service.finPrevue > service.heureArrivee ? service.finPrevue : service.heureArrivee;
        service.heureDepart = depart;
        service.dureeMinutes = minutesEntre(service.heureArrivee, depart);
        service.departAnticipeMinutes = 0;
        service.cloture = 'automatique';
        service.commentaire = service.commentaire || 'Départ non pointé : clôture automatique à l\'heure de fin prévue';
        await service.save();
    }
};

const mettreAJourGardien = (gardienId, statut, position) => Gardien.updateOne(
    { _id: gardienId },
    { $set: { statut, 'coordonnees.lat': position.lat, 'coordonnees.lng': position.lng } }
);

// Services que le gardien peut commencer maintenant (fenêtre : de 1 h avant le début jusqu'à la fin prévue)
const servicesPointables = async (gardienId, maintenant) => {
    const aujourdHui = jourLocal(maintenant);
    const affectations = await Affectation.find({
        gardien: gardienId,
        dateDebut: { $lt: new Date(maintenant.getTime() + 2 * 86400000) },
        dateFin: { $gt: new Date(maintenant.getTime() - 2 * 86400000) }
    }).populate('propriete', 'nomReference coordonnees');

    const candidats = [];
    for (const aff of affectations) {
        for (const jour of [decalerJour(aujourdHui, -1), aujourdHui, decalerJour(aujourdHui, 1)]) {
            const service = servicePrevu(aff, jour);
            if (service
                && maintenant.getTime() >= service.debutPrevu.getTime() - AVANCE_MAX_MINUTES * 60000
                && maintenant < service.finPrevue) {
                candidats.push({ ...service, affectation: aff });
            }
        }
    }
    return candidats;
};

// Prochains services du gardien (7 jours), pour l'application du gardien
const prochainsServices = async (gardienId, maintenant, nombre = 5) => {
    const aujourdHui = jourLocal(maintenant);
    const prevus = await servicesPrevus({ du: decalerJour(aujourdHui, -1), au: decalerJour(aujourdHui, 7), gardien: gardienId });
    return prevus
        .filter((p) => p.finPrevue > maintenant)
        .sort((a, b) => a.debutPrevu - b.debutPrevu)
        .slice(0, nombre)
        .map((p) => ({
            jourService: p.jourService,
            debutPrevu: p.debutPrevu,
            finPrevue: p.finPrevue,
            role: p.affectation.role,
            affectation: p.affectation._id,
            propriete: p.affectation.propriete
        }));
};

// ---------- Gardien ----------

// Début de service (token GARDIEN). Body : lat, lng, [precision], [affectation] (si plusieurs services possibles)
exports.commencer = async (req, res) => {
    try {
        exigerGardien(req);
        const position = lirePosition(req.body);
        const maintenant = new Date();
        const gardienId = req.admin.id;

        await cloturerOublies({ gardien: gardienId });
        const enCours = await Presence.findOne({ gardien: gardienId, heureDepart: null }).populate('propriete', 'nomReference');
        if (enCours) {
            throw erreur(
                409,
                `Vous avez déjà un service en cours à « ${enCours.propriete?.nomReference || 'une propriété'} » depuis ${heureLocale(enCours.heureArrivee)} : terminez-le d'abord`,
                { serviceEnCours: enCours._id }
            );
        }

        let candidats = await servicesPointables(gardienId, maintenant);
        if (req.body.affectation !== undefined) {
            verifierIdentifiant(req.body.affectation, 'Identifiant d\'affectation');
            candidats = candidats.filter((c) => String(c.affectation._id) === String(req.body.affectation));
        }
        if (!candidats.length) {
            throw erreur(400, 'Aucun service prévu pour vous en ce moment', {
                prochainsServices: await prochainsServices(gardienId, maintenant, 3)
            });
        }

        const dejaPointes = await Presence.find({
            $or: candidats.map((c) => ({ affectation: c.affectation._id, jourService: c.jourService }))
        }).select('affectation jourService');
        const cles = new Set(dejaPointes.map((p) => `${p.affectation}|${p.jourService}`));
        candidats = candidats.filter((c) => !cles.has(`${c.affectation._id}|${c.jourService}`));
        if (!candidats.length) throw erreur(409, 'Ce service a déjà été effectué');

        // Plusieurs services possibles : celui de la propriété la plus proche
        const choisi = candidats
            .map((c) => ({ ...c, position: positionPres(position, c.affectation.propriete) }))
            .sort((a, b) => (a.position.distanceMetres ?? Infinity) - (b.position.distanceMetres ?? Infinity))[0];

        const retardMinutes = Math.max(0, minutesEntre(choisi.debutPrevu, maintenant));
        const presence = await Presence.create({
            gardien: gardienId,
            propriete: choisi.affectation.propriete._id,
            affectation: choisi.affectation._id,
            jourService: choisi.jourService,
            debutPrevu: choisi.debutPrevu,
            finPrevue: choisi.finPrevue,
            heureArrivee: maintenant,
            positionArrivee: choisi.position,
            retardMinutes,
            enRetard: retardMinutes > TOLERANCE_RETARD_MINUTES
        });
        await mettreAJourGardien(gardienId, 'en service', position);

        await peupler(presence);
        const message = presence.enRetard
            ? `Service commencé avec ${retardMinutes} min de retard`
            : 'Service commencé';
        return res.status(201).json({ success: true, message, presence });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Fin de service (token GARDIEN). Body : lat, lng, [precision], [commentaire]
exports.terminer = async (req, res) => {
    try {
        exigerGardien(req);
        const position = lirePosition(req.body);
        const maintenant = new Date();

        const presence = await Presence.findOne({ gardien: req.admin.id, heureDepart: null })
            .sort({ heureArrivee: -1 })
            .populate('propriete', 'coordonnees');
        if (!presence) throw erreur(404, 'Aucun service en cours');

        presence.heureDepart = maintenant;
        presence.positionDepart = positionPres(position, presence.propriete);
        presence.dureeMinutes = minutesEntre(presence.heureArrivee, maintenant);
        presence.departAnticipeMinutes = Math.max(0, minutesEntre(maintenant, presence.finPrevue));
        presence.cloture = 'gardien';
        if (req.body.commentaire !== undefined) presence.commentaire = String(req.body.commentaire).trim();
        await presence.save();
        await mettreAJourGardien(req.admin.id, 'non en service', position);

        await peupler(presence);
        return res.status(200).json({ success: true, message: 'Service terminé', presence });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Service en cours et prochains services du gardien connecté
exports.monService = async (req, res) => {
    try {
        exigerGardien(req);
        const maintenant = new Date();
        const enCours = await Presence.findOne({ gardien: req.admin.id, heureDepart: null }).sort({ heureArrivee: -1 });
        if (enCours) await peupler(enCours);
        const pointables = await servicesPointables(req.admin.id, maintenant);

        return res.status(200).json({
            success: true,
            serviceEnCours: enCours,
            peutCommencer: !enCours && pointables.length > 0,
            prochainsServices: await prochainsServices(req.admin.id, maintenant)
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Historique des services du gardien connecté. Query : du, au (AAAA-MM-JJ)
exports.mesServices = async (req, res) => {
    try {
        exigerGardien(req);
        const periode = lirePeriode(req.query);
        const presences = await peupler(Presence.find({
            gardien: req.admin.id,
            debutPrevu: { $gte: periode.debut, $lt: periode.fin }
        }).sort({ debutPrevu: -1 }));
        const minutes = presences.reduce((total, p) => total + (p.dureeMinutes || 0), 0);
        return res.status(200).json({
            success: true, du: periode.du, au: periode.au, total: presences.length,
            minutesTravaillees: minutes, heuresTravaillees: Math.round((minutes / 60) * 100) / 100,
            presences
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Entreprise (admin) ----------

// Présences / historique des services.
// Query : du, au (AAAA-MM-JJ, défaut 30 derniers jours), gardien, propriete, affectation,
//         statut ("en cours" | "termine" | "non cloture"), enRetard=true, horsZone=true
exports.getAll = async (req, res) => {
    try {
        const periode = lirePeriode(req.query);
        const filtre = { ...filtreIdentifiants(req.query), debutPrevu: { $gte: periode.debut, $lt: periode.fin } };
        if (req.query.statut !== undefined) {
            const filtreStatut = Presence.filtreStatut(req.query.statut);
            if (!filtreStatut) throw erreur(400, 'Statut invalide : en cours, termine, non cloture');
            Object.assign(filtre, filtreStatut);
        }
        if (req.query.enRetard === 'true') filtre.enRetard = true;
        if (req.query.horsZone === 'true') {
            filtre.$or = [{ 'positionArrivee.horsZone': true }, { 'positionDepart.horsZone': true }];
        }

        const presences = await peupler(Presence.find(filtre).sort({ debutPrevu: -1 }));
        return res.status(200).json({ success: true, du: periode.du, au: periode.au, total: presences.length, presences });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Absences : services prévus jamais pointés. Query : du, au, gardien, propriete, affectation
exports.absences = async (req, res) => {
    try {
        const periode = lirePeriode(req.query);
        const absences = await calculerAbsences({ ...periode, ...filtreIdentifiants(req.query) });
        return res.status(200).json({ success: true, du: periode.du, au: periode.au, total: absences.length, absences });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Rapport : présences, absences, retards et heures travaillées, au total et par gardien.
// Query : du, au, gardien, propriete
exports.rapport = async (req, res) => {
    try {
        const periode = lirePeriode(req.query);
        const criteres = { ...periode, ...filtreIdentifiants(req.query) };
        const filtre = { ...filtreIdentifiants(req.query), debutPrevu: { $gte: periode.debut, $lt: periode.fin } };

        const [presences, absences] = await Promise.all([
            Presence.find(filtre).populate('gardien', CHAMPS_GARDIEN),
            calculerAbsences(criteres)
        ]);

        const ligneVide = (gardien) => ({
            gardien, presences: 0, absences: 0, pasEncoreArrives: 0, retards: 0, minutesRetard: 0,
            minutesTravaillees: 0, nonClotures: 0, horsZone: 0
        });
        const totaux = ligneVide(undefined);
        delete totaux.gardien;
        const parGardien = new Map();
        const ligne = (gardien) => {
            const cle = String(gardien?._id ?? gardien);
            if (!parGardien.has(cle)) parGardien.set(cle, ligneVide(gardien));
            return parGardien.get(cle);
        };

        for (const p of presences) {
            for (const cible of [totaux, ligne(p.gardien)]) {
                cible.presences += 1;
                if (p.enRetard) { cible.retards += 1; cible.minutesRetard += p.retardMinutes; }
                cible.minutesTravaillees += p.dureeMinutes || 0;
                if (p.statut === 'non cloture' || p.cloture === 'automatique') cible.nonClotures += 1;
                if (p.positionArrivee?.horsZone || p.positionDepart?.horsZone) cible.horsZone += 1;
            }
        }
        for (const a of absences) {
            for (const cible of [totaux, ligne(a.gardien)]) {
                if (a.etat === 'absent') cible.absences += 1;
                else cible.pasEncoreArrives += 1;
            }
        }

        const completer = (cible) => ({
            ...cible,
            heuresTravaillees: Math.round((cible.minutesTravaillees / 60) * 100) / 100,
            tauxPresence: cible.presences + cible.absences
                ? Math.round((cible.presences / (cible.presences + cible.absences)) * 1000) / 10
                : null
        });

        return res.status(200).json({
            success: true,
            du: periode.du,
            au: periode.au,
            reglages: { toleranceRetardMinutes: TOLERANCE_RETARD_MINUTES, rayonZoneMetres: RAYON_ZONE_METRES },
            totaux: completer(totaux),
            parGardien: [...parGardien.values()].map(completer).sort((a, b) => b.minutesTravaillees - a.minutesTravaillees)
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

exports.getById = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const presence = await peupler(Presence.findById(req.params.id));
        if (!presence) throw erreur(404, 'Présence introuvable');
        if (req.admin.role === 'GARDIEN' && String(presence.gardien._id) !== String(req.admin.id)) {
            throw erreur(403, 'Accès refusé');
        }
        return res.status(200).json({ success: true, presence });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Clôturer un service à la place du gardien (admin). Body : [heureDepart] (ISO, défaut : fin prévue ou maintenant), [commentaire]
exports.cloturer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        await verifierAdmin(req);
        const presence = await Presence.findById(req.params.id);
        if (!presence) throw erreur(404, 'Présence introuvable');
        if (presence.heureDepart) throw erreur(400, 'Ce service est déjà terminé');

        const maintenant = new Date();
        let depart = presence.finPrevue < maintenant ? presence.finPrevue : maintenant;
        if (req.body?.heureDepart !== undefined && req.body.heureDepart !== '') {
            depart = new Date(req.body.heureDepart);
            if (Number.isNaN(depart.getTime())) throw erreur(400, 'Heure de départ invalide');
        }
        if (depart < presence.heureArrivee || depart > maintenant) {
            throw erreur(400, 'L\'heure de départ doit être entre l\'arrivée et maintenant');
        }

        presence.heureDepart = depart;
        presence.dureeMinutes = minutesEntre(presence.heureArrivee, depart);
        presence.departAnticipeMinutes = Math.max(0, minutesEntre(depart, presence.finPrevue));
        presence.cloture = 'admin';
        presence.cloturePar = req.admin.id;
        if (req.body?.commentaire !== undefined) presence.commentaire = String(req.body.commentaire).trim();
        await presence.save();
        await Gardien.updateOne({ _id: presence.gardien }, { $set: { statut: 'non en service' } });

        await peupler(presence);
        return res.status(200).json({ success: true, message: 'Service clôturé', presence });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer un pointage erroné (super admin)
exports.supprimer = async (req, res) => {
    try {
        verifierIdentifiant(req.params.id);
        const presence = await Presence.findByIdAndDelete(req.params.id);
        if (!presence) throw erreur(404, 'Présence introuvable');
        if (!presence.heureDepart) {
            await Gardien.updateOne({ _id: presence.gardien }, { $set: { statut: 'non en service' } });
        }
        return res.status(200).json({ success: true, message: 'Présence supprimée' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
