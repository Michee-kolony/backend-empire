const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { r2, R2_BUCKET, R2_PUBLIC_URL } = require('../config/r2');

const MIN_PHOTOS = 1;
const MAX_PHOTOS = 5;
const TAILLE_MAX = 20 * 1024 * 1024; // 20 Mo par photo
// Extensions autorisées et leur type MIME (tous les formats d'image courants sauf le GIF)
const TYPES_AUTORISES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jpe': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.heic': 'image/heic', // photos iPhone
    '.heif': 'image/heif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff'
};
// Variantes de type MIME envoyées par certains navigateurs / téléphones pour ces mêmes formats
const MIME_ALTERNATIFS = {
    'image/pjpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/x-png': 'image/png',
    'image/heic-sequence': 'image/heic',
    'image/heif-sequence': 'image/heif',
    'image/x-ms-bmp': 'image/bmp',
    'image/x-bmp': 'image/bmp'
};
const FORMATS_IMAGES = 'JPEG, PNG, WEBP, AVIF, HEIC, HEIF, BMP ou TIFF (GIF refusé)';

// Documents : PDF en plus des images
const TYPES_DOCUMENTS = { ...TYPES_AUTORISES, '.pdf': 'application/pdf' };
const TAILLE_MAX_DOCUMENT = 20 * 1024 * 1024; // 20 Mo par fichier

// Vidéos (incidents)
const TYPES_VIDEOS = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.3gp': 'video/3gpp'
};
const TAILLE_MAX_VIDEO = 30 * 1024 * 1024; // 30 Mo par vidéo
// Ces limites doivent rester sous client_max_body_size de nginx (deploy/nginx-backend-empire.conf)
// et identiques à celles du frontend (gardinnage/src/app/core/proprietes.service.ts)

// Vérifie le format d'un fichier selon les types autorisés
const verifierFormat = (file, types, formats) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (MIME_ALTERNATIFS[file.mimetype]) file.mimetype = MIME_ALTERNATIFS[file.mimetype];
    const mimeValide = Object.values(types).includes(file.mimetype);

    // Certains clients (ex: Postman) envoient "application/octet-stream" : on se fie alors à l'extension
    if (mimeValide || types[extension]) {
        if (!mimeValide) file.mimetype = types[extension];
        return null;
    }

    const erreur = new Error(`Format refusé pour "${file.fieldname}" (${file.mimetype}, ${extension || 'sans extension'}) : ${formats} uniquement`);
    erreur.code = 'FORMAT_INVALIDE';
    return erreur;
};

// Les fichiers restent en mémoire puis sont envoyés directement sur R2
const multerConfig = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAILLE_MAX, files: MAX_PHOTOS },
    fileFilter: (req, file, cb) => {
        const erreur = verifierFormat(file, TYPES_AUTORISES, FORMATS_IMAGES);
        erreur ? cb(erreur) : cb(null, true);
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
            LIMIT_FILE_SIZE: 'Fichier trop volumineux (20 Mo max par photo ou document, 30 Mo max par vidéo)',
            LIMIT_FILE_COUNT: 'Trop de fichiers envoyés',
            LIMIT_UNEXPECTED_FILE: `Champ fichier inattendu ou trop de fichiers pour "${error.field}". Vérifie le nom du champ et le nombre de fichiers`
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

// Middleware : reçoit plusieurs champs de fichiers et les envoie dans "<dossier>/<nom du champ>"
// champs : [{ name: 'photos', maxCount: 5 }, { name: 'document', maxCount: 1, documents: true }]
// (documents: true accepte aussi le PDF, videos: true accepte uniquement des vidéos, sinon images uniquement)
// Les URLs sont placées dans req.fichiers : { photos: [...], document: [...] } (tableau vide si rien n'est envoyé)
const uploadFichiers = (dossier, champs) => {
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: Math.max(TAILLE_MAX, TAILLE_MAX_DOCUMENT, champs.some((c) => c.videos) ? TAILLE_MAX_VIDEO : 0) },
        fileFilter: (req, file, cb) => {
            const champ = champs.find((c) => c.name === file.fieldname);
            if (!champ) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));

            let erreur;
            if (champ.videos) {
                erreur = verifierFormat(file, TYPES_VIDEOS, 'MP4, MOV, WEBM ou 3GP');
                file.tailleMax = TAILLE_MAX_VIDEO;
            } else if (champ.documents) {
                erreur = verifierFormat(file, TYPES_DOCUMENTS, `PDF, ${FORMATS_IMAGES}`);
                file.tailleMax = TAILLE_MAX_DOCUMENT;
            } else {
                erreur = verifierFormat(file, TYPES_AUTORISES, FORMATS_IMAGES);
                file.tailleMax = TAILLE_MAX;
            }
            erreur ? cb(erreur) : cb(null, true);
        }
    }).fields(champs.map(({ name, maxCount }) => ({ name, maxCount })));

    return (req, res, next) => {
        upload(req, res, async (error) => {
            if (error) return gererErreurMulter(error, res);

            // La limite de multer est la plus large : on vérifie ici la limite propre à chaque type de fichier
            const tropLourd = Object.values(req.files || {}).flat().find((file) => file.size > file.tailleMax);
            if (tropLourd) {
                const limite = tropLourd.tailleMax / (1024 * 1024);
                return res.status(400).json({ success: false, message: `Le fichier "${tropLourd.originalname}" dépasse ${limite} Mo` });
            }

            const envoyes = [];
            try {
                req.fichiers = {};
                for (const { name } of champs) {
                    const fichiers = (req.files && req.files[name]) || [];
                    req.fichiers[name] = await Promise.all(fichiers.map(async (file) => {
                        const url = await envoyerSurR2(file, `${dossier}/${name}`);
                        envoyes.push(url);
                        return url;
                    }));
                }
                next();
            } catch (erreur) {
                // Envoi incomplet : on retire du bucket ce qui a déjà été envoyé
                supprimerDeR2(envoyes).catch(() => {});
                res.status(500).json({ success: false, message: "Échec de l'envoi des fichiers : " + erreur.message });
            }
        });
    };
};

module.exports = uploadPhotos;
module.exports.uploadFichiers = uploadFichiers;
module.exports.uploadPhoto = uploadPhoto;
module.exports.supprimerDeR2 = supprimerDeR2;
