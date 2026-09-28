const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { r2, R2_BUCKET, R2_PUBLIC_URL } = require('../config/r2');

const MIN_PHOTOS = 1;
const MAX_PHOTOS = 5;
const TAILLE_MAX = 5 * 1024 * 1024; // 5 Mo par photo
// Extensions autorisées et leur type MIME
const TYPES_AUTORISES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif'
};

// Les fichiers restent en mémoire puis sont envoyés directement sur R2
const multerConfig = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAILLE_MAX, files: MAX_PHOTOS },
    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const mimeValide = Object.values(TYPES_AUTORISES).includes(file.mimetype);

        // Certains clients (ex: Postman) envoient "application/octet-stream" : on se fie alors à l'extension
        if (mimeValide || TYPES_AUTORISES[extension]) {
            if (!mimeValide) file.mimetype = TYPES_AUTORISES[extension];
            return cb(null, true);
        }

        const erreur = new Error(`Format refusé (${file.mimetype}, ${extension || 'sans extension'}) : JPEG, PNG, WEBP ou AVIF uniquement`);
        erreur.code = 'FORMAT_INVALIDE';
        cb(erreur);
    }
});

// Envoie une photo sur R2 dans le dossier demandé et renvoie son URL publique
const envoyerSurR2 = async (file, dossier = 'photos') => {
    const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
    const cle = `${dossier}/${Date.now()}-${crypto.randomUUID()}${extension}`;

    await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: cle,
        Body: file.buffer,
        ContentType: file.mimetype
    }));

    return `${R2_PUBLIC_URL}/${cle}`;
};

// Supprime de R2 les photos à partir de leurs URLs publiques
// (les URLs qui ne pointent pas vers notre bucket sont ignorées)
const supprimerDeR2 = async (urls) => {
    const cles = urls
        .filter((url) => url && url.startsWith(`${R2_PUBLIC_URL}/`))
        .map((url) => url.slice(R2_PUBLIC_URL.length + 1));

    await Promise.all(cles.map((cle) => r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: cle }))));
};

// Transforme une erreur multer en réponse 400 lisible
const gererErreurMulter = (error, res) => {
    if (error instanceof multer.MulterError) {
        const messages = {
            LIMIT_FILE_SIZE: 'Une photo dépasse 5 Mo',
            LIMIT_FILE_COUNT: `${MAX_PHOTOS} photos maximum`,
            LIMIT_UNEXPECTED_FILE: `Champ fichier inattendu : "${error.field}". Vérifie le nom du champ du fichier dans ta requête`
        };
        return res.status(400).json({ success: false, message: messages[error.code] || error.message });
    }
    if (error.code === 'FORMAT_INVALIDE') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

// Middleware : reçoit 1 à 5 photos (champ "photos") et place leurs URLs dans req.photos
const uploadPhotos = (req, res, next) => {
    multerConfig.array('photos', MAX_PHOTOS)(req, res, async (error) => {
        if (error) return gererErreurMulter(error, res);

        if (!req.files || req.files.length < MIN_PHOTOS) {
            return res.status(400).json({ success: false, message: `Au moins ${MIN_PHOTOS} photo requise` });
        }

        try {
            req.photos = await Promise.all(req.files.map((file) => envoyerSurR2(file)));
            next();
        } catch (erreur) {
            res.status(500).json({ success: false, message: "Échec de l'envoi des photos : " + erreur.message });
        }
    });
};

// Middleware : reçoit une seule photo (dans le champ indiqué), l'envoie dans le dossier indiqué
// et place son URL dans req.photo (reste undefined si aucune photo n'est envoyée)
const uploadPhoto = (dossier, champ = 'photo') => (req, res, next) => {
    multerConfig.single(champ)(req, res, async (error) => {
        if (error) return gererErreurMulter(error, res);
        if (!req.file) return next();

        try {
            req.photo = await envoyerSurR2(req.file, dossier);
            next();
        } catch (erreur) {
            res.status(500).json({ success: false, message: "Échec de l'envoi de la photo : " + erreur.message });
        }
    });
};

module.exports = uploadPhotos;
module.exports.uploadPhoto = uploadPhoto;
module.exports.supprimerDeR2 = supprimerDeR2;
