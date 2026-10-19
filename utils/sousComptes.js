const Propriete = require('../models/propriete');
const SousCompte = require('../models/sousCompte');

const TYPES_APPARTEMENT = ['immeuble', 'appartement'];

const libelleLogement = (propriete, numero) =>
    `${TYPES_APPARTEMENT.includes(propriete.typePropriete) ? 'Appartement' : 'Logement'} ${numero}`;

// Erreur renvoyée telle quelle au client avec un statut 400
const erreur400 = (message) => Object.assign(new Error(message), { statut: 400 });

// Aligne les sous-comptes d'une propriété sur son nombre de logements :
// - crée les sous-comptes manquants (numéros 1 à nombreLogements)
// - supprime ceux en trop, uniquement s'ils sont libres (sinon erreur 400 avant toute écriture)
// - les rattache au propriétaire actuel de la propriété
const synchroniserSousComptes = async (propriete) => {
    const total = propriete.nombreLogements || 1;
    const existants = await SousCompte.find({ propriete: propriete._id });

    const enTrop = existants.filter((s) => s.numero > total);
    const occupes = enTrop.filter((s) => s.nom);
    if (occupes.length) {
        throw erreur400(
            `Impossible de réduire à ${total} logement(s) : ${occupes.map((s) => s.libelle).join(', ')} ` +
            'encore occupé(s). Libérez-les d\'abord.'
        );
    }

    if (enTrop.length) {
        await SousCompte.deleteMany({ _id: { $in: enTrop.map((s) => s._id) } });
    }

    const numerosExistants = new Set(existants.map((s) => s.numero));
    const manquants = [];
    for (let numero = 1; numero <= total; numero++) {
        if (!numerosExistants.has(numero)) {
            manquants.push({
                proprietaire: propriete.proprietaire,
                propriete: propriete._id,
                numero,
                libelle: libelleLogement(propriete, numero)
            });
        }
    }
    if (manquants.length) await SousCompte.insertMany(manquants);

    await SousCompte.updateMany(
        { propriete: propriete._id, proprietaire: { $ne: propriete.proprietaire } },
        { $set: { proprietaire: propriete.proprietaire } }
    );
};

// Au démarrage : aligne les index sur le modèle (retire les anciens index uniques téléphone / email
// de la version avec identifiants) et crée les sous-comptes des propriétés enregistrées avant cette fonctionnalité
const synchroniserTousLesSousComptes = async () => {
    await SousCompte.syncIndexes();
    // Anciens identifiants de connexion des locataires : plus utilisés
    await SousCompte.collection.updateMany(
        { $or: [{ password: { $exists: true } }, { email: { $exists: true } }, { actif: { $exists: true } }] },
        { $unset: { password: '', email: '', actif: '' } }
    );
    const proprietes = await Propriete.find().select('proprietaire typePropriete nombreLogements');
    for (const propriete of proprietes) {
        await synchroniserSousComptes(propriete).catch((error) =>
            console.error(`Sous-comptes de la propriété ${propriete._id} :`, error.message));
    }
};

module.exports = { synchroniserSousComptes, synchroniserTousLesSousComptes };
