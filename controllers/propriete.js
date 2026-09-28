const mongoose = require('mongoose');
const Propriete = require('../models/propriete');
const { supprimerDeR2 } = require('../middleware/upload');

const CHAMPS_TEXTE = [
    'proprietaire', 'nomReference', 'typeAutre', 'numeroParcelle',
    'commune', 'quartier', 'avenue', 'numero', 'referenceComplementaire', 'lienCarte',
    'autresInformations', 'autresEquipementsSecurite'
];

// Valeurs à choix : les accents et majuscules sont ignorés ("Renforcé" -> "renforce")
const CHAMPS_CHOIX = ['typePropriete', 'niveauSecurite'];

const CHAMPS_NOMBRE = [
    'nombreBatiments', 'nombreNiveaux', 'nombreChambres', 'nombrePortesAcces',
    'nombreVehicules', 'nombreCameras', 'prixAbonnement'
];

const CHAMPS_DATE = ['dateDebutAbonnement', 'dateExpirationAbonnement'];

const CHAMPS_OUI_NON = ['cloture', 'portail', 'garage', 'cameras', 'alarme', 'eclairageSecurite', 'interphone'];

const CHAMPS_OBLIGATOIRES = ['proprietaire', 'nomReference', 'typePropriete', 'commune', 'quartier', 'avenue'];

const sansAccents = (texte) => String(texte).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// "oui", "true", "1" -> true ; "non", "false", "0" -> false ; sinon la valeur est gardée (Mongoose la rejettera)
const ouiNon = (valeur) => {
    const v = sansAccents(valeur);
    if (['oui', 'true', '1'].includes(v)) return true;
    if (['non', 'false', '0'].includes(v)) return false;
    return valeur;
};

// Construit les données de la propriété à partir des champs envoyés (seuls les champs présents sont pris)
const lireChamps = (body) => {
    const data = {};

    CHAMPS_TEXTE.forEach((champ) => {
        if (body[champ] !== undefined) data[champ] = body[champ];
    });
    CHAMPS_CHOIX.forEach((champ) => {
        if (body[champ] !== undefined) data[champ] = sansAccents(body[champ]);
    });
    CHAMPS_NOMBRE.forEach((champ) => {
        if (body[champ] !== undefined) data[champ] = body[champ] === '' ? null : body[champ];
    });
    CHAMPS_DATE.forEach((champ) => {
        if (body[champ] !== undefined) data[champ] = body[champ] === '' ? null : body[champ];
    });
    CHAMPS_OUI_NON.forEach((champ) => {
        if (body[champ] !== undefined) data[champ] = ouiNon(body[champ]);
    });

    if (body.lat !== undefined) data['coordonnees.lat'] = body.lat === '' ? null : body.lat;
    if (body.lng !== undefined) data['coordonnees.lng'] = body.lng === '' ? null : body.lng;

    return data;
};

// Toutes les URLs de fichiers envoyées sur R2 pendant cette requête
const fichiersEnvoyes = (req) => Object.values(req.fichiers || {}).flat();

// Toutes les URLs de fichiers d'une propriété
const fichiersDe = (propriete) => [
    ...propriete.photos,
    propriete.documentPropriete,
    ...propriete.autresDocuments
];

const repondreErreur = (error, res) => {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: error.message });
};

// Ajouter une propriété (multipart/form-data)
// Fichiers : "photos" (0 à 5 images), "documentPropriete" (1 PDF ou image), "autresDocuments" (0 à 5 PDF ou images)
exports.ajouter = async (req, res) => {
    const annulerFichiers = () => supprimerDeR2(fichiersEnvoyes(req)).catch(() => {});

    try {
        const manquants = CHAMPS_OBLIGATOIRES.filter((champ) => !req.body[champ]);
        if (manquants.length) {
            annulerFichiers();
            return res.status(400).json({ success: false, message: 'Champs obligatoires manquants : ' + manquants.join(', ') });
        }

        const propriete = new Propriete();
        propriete.set(lireChamps(req.body));
        propriete.photos = req.fichiers.photos;
        propriete.documentPropriete = req.fichiers.documentPropriete[0] || null;
        propriete.autresDocuments = req.fichiers.autresDocuments;

        await propriete.save();

        res.status(201).json({ success: true, message: 'Propriété ajoutée avec succès', propriete });
    } catch (error) {
        annulerFichiers();
        repondreErreur(error, res);
    }
};

// Récupérer toutes les propriétés
exports.getAll = async (req, res) => {
    try {
        const proprietes = await Propriete.find().sort({ createdAt: -1 });

        res.status(200).json({ success: true, total: proprietes.length, proprietes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Récupérer une propriété par son id
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const propriete = await Propriete.findById(id);
        if (!propriete) {
            return res.status(404).json({ success: false, message: 'Propriété introuvable' });
        }

        res.status(200).json({ success: true, propriete });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Modifier une propriété (multipart/form-data) : seuls les champs envoyés sont modifiés.
// Si des fichiers sont envoyés dans un champ ("photos", "documentPropriete" ou "autresDocuments"),
// ils REMPLACENT les anciens de ce champ, qui sont supprimés du bucket.
exports.modifier = async (req, res) => {
    const annulerFichiers = () => supprimerDeR2(fichiersEnvoyes(req)).catch(() => {});

    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            annulerFichiers();
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const propriete = await Propriete.findById(id);
        if (!propriete) {
            annulerFichiers();
            return res.status(404).json({ success: false, message: 'Propriété introuvable' });
        }

        propriete.set(lireChamps(req.body));

        const anciensFichiers = [];
        if (req.fichiers.photos.length) {
            anciensFichiers.push(...propriete.photos);
            propriete.photos = req.fichiers.photos;
        }
        if (req.fichiers.documentPropriete.length) {
            anciensFichiers.push(propriete.documentPropriete);
            propriete.documentPropriete = req.fichiers.documentPropriete[0];
        }
        if (req.fichiers.autresDocuments.length) {
            anciensFichiers.push(...propriete.autresDocuments);
            propriete.autresDocuments = req.fichiers.autresDocuments;
        }

        await propriete.save();

        // La modification est enregistrée : on peut supprimer les anciens fichiers remplacés
        try {
            await supprimerDeR2(anciensFichiers);
        } catch (erreur) {
            console.error('Suppression des anciens fichiers R2 échouée :', erreur.message);
        }

        res.status(200).json({ success: true, message: 'Propriété modifiée avec succès', propriete });
    } catch (error) {
        annulerFichiers();
        repondreErreur(error, res);
    }
};

// Supprimer une propriété (et toutes ses photos et documents dans le bucket)
exports.supprimer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Identifiant invalide' });
        }

        const propriete = await Propriete.findByIdAndDelete(id);
        if (!propriete) {
            return res.status(404).json({ success: false, message: 'Propriété introuvable' });
        }

        try {
            await supprimerDeR2(fichiersDe(propriete));
        } catch (erreur) {
            console.error('Suppression des fichiers R2 échouée :', erreur.message);
        }

        res.status(200).json({ success: true, message: 'Propriété supprimée avec succès' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
