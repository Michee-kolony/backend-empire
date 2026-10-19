const mongoose = require('mongoose');

// Compte de connexion d'un locataire : créé par le propriétaire quand il inscrit le locataire
// d'un logement avec un email et un mot de passe (voir controllers/sousCompte.js).
// Le locataire se connecte à l'application propriétaire (espace « Locataire ») et discute par chat
// avec son propriétaire et avec les gardiens en service sur la propriété (voir controllers/chat.js).
// Le compte est supprimé quand le logement est libéré : un nouveau locataire du même logement
// n'a donc jamais accès aux discussions de l'ancien.
const locataireSchema = new mongoose.Schema(
    {
        sousCompte: { type: mongoose.Schema.Types.ObjectId, ref: 'SousCompte', required: true, unique: true },
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true, index: true, immutable: true },

        // Copie de la fiche du logement (nom affiché dans le chat), mise à jour par le propriétaire
        nom: { type: String, required: true, trim: true },
        postnom: { type: String, trim: true },
        prenom: { type: String, trim: true },
        telephone: { type: String, trim: true },

        email: { type: String, required: true, unique: true, trim: true, lowercase: true },
        password: { type: String, required: true },
        photo: { type: String, default: null },

        role: { type: String, enum: ['LOCATAIRE'], default: 'LOCATAIRE', immutable: true },
        actif: { type: Boolean, default: true }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('Locataire', locataireSchema);
