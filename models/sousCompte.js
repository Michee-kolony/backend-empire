const mongoose = require('mongoose');

// Sous-compte locataire : un par logement d'une propriété (ex : 1 immeuble de 8 appartements = 8 sous-comptes).
// Ils sont créés automatiquement à partir de "nombreLogements" de la propriété (voir utils/sousComptes.js).
// Seul le propriétaire y inscrit ou en retire un locataire ; l'administration les consulte.
// Le locataire n'a pas d'identifiants : il ne se connecte pas, seul le propriétaire se connecte.
const sousCompteSchema = new mongoose.Schema(
    {
        // Compte principal auquel ce sous-compte est rattaché
        proprietaire: { type: mongoose.Schema.Types.ObjectId, ref: 'Proprietaire', required: true, index: true },
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },

        // Numéro du logement dans la propriété (1 à nombreLogements)
        numero: { type: Number, required: true, min: 1 },
        libelle: { type: String, trim: true, required: true },

        // Locataire occupant le logement (absent tant que le logement est libre)
        nom: { type: String, trim: true },
        postnom: { type: String, trim: true },
        prenom: { type: String, trim: true },
        // Simple contact, facultatif
        telephone: { type: String, trim: true },
        dateEntree: { type: Date }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

sousCompteSchema.index({ propriete: 1, numero: 1 }, { unique: true });

// "occupe" : un locataire est inscrit ; "libre" : aucun locataire
sousCompteSchema.virtual('statut').get(function () {
    return this.nom ? 'occupe' : 'libre';
});

module.exports = mongoose.model('SousCompte', sousCompteSchema);
