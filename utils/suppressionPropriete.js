const Affectation = require('../models/affectation');
const Incident = require('../models/incident');
const Presence = require('../models/presence');
const Propriete = require('../models/propriete');
const Rapport = require('../models/rapport');
const { supprimerDeR2 } = require('../middleware/upload');

// Toutes les URLs de fichiers d'une propriété
const fichiersDe = (propriete) => [
    ...propriete.photos,
    propriete.documentPropriete,
    ...propriete.autresDocuments
];

// Supprime des propriétés déjà retirées de la base avec tout ce qui en dépend :
// affectations, présences, rapports, incidents, ainsi que leurs fichiers dans le bucket
// (photos et documents des propriétés, photos et vidéos des incidents).
// Les paiements sont conservés comme trace comptable.
const supprimerDependancesProprietes = async (proprietes) => {
    if (!proprietes.length) return;

    const ids = proprietes.map((p) => p._id);
    const incidents = await Incident.find({ propriete: { $in: ids } }).select('photos videos');

    await Affectation.deleteMany({ propriete: { $in: ids } });
    await Presence.deleteMany({ propriete: { $in: ids } });
    await Rapport.deleteMany({ propriete: { $in: ids } });
    await Incident.deleteMany({ propriete: { $in: ids } });

    const fichiers = [
        ...proprietes.flatMap(fichiersDe),
        ...incidents.flatMap((i) => [...i.photos, ...i.videos])
    ];
    try {
        await supprimerDeR2(fichiers);
    } catch (erreur) {
        console.error('Suppression des fichiers R2 échouée :', erreur.message);
    }
};

// Supprime toutes les propriétés d'un propriétaire et leurs dépendances
const supprimerProprietesDe = async (proprietaireId) => {
    const proprietes = await Propriete.find({ proprietaire: proprietaireId });
    await Propriete.deleteMany({ _id: { $in: proprietes.map((p) => p._id) } });
    await supprimerDependancesProprietes(proprietes);
    return proprietes.length;
};

module.exports = { fichiersDe, supprimerDependancesProprietes, supprimerProprietesDe };
