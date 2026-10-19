const mongoose = require('mongoose');

// Sous-compte locataire : un par logement d'une propriété (ex : 1 immeuble de 8 appartements = 8 sous-comptes).
// Ils sont créés automatiquement à partir de "nombreLogements" de la propriété (voir utils/sousComptes.js)
// et gérés depuis le compte principal du propriétaire, qui y attribue ou en retire un locataire.
const sousCompteSchema = new mongoose.Schema(
    {
        // Compte principal auquel ce sous-compte est rattaché
        proprietaire: { type: mongoose.Schema.Types.ObjectId, ref: 'Proprietaire', required: true, index: true },
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },

        // Numéro du logement dans la propriété (1 à nombreLogements)
        numero: { type: Number, required: true, min: 1 },
        libelle: { type: String, trim: true, required: true },

        // Locataire occupant le logement (absent tant que le logement est libre).
        // Pas de valeur par défaut : les index uniques "sparse" ignorent les champs absents, pas les null.
        nom: { type: String, trim: true },
        postnom: { type: String, trim: true },
        prenom: { type: String, trim: true },
        telephone: { type: String, trim: true, unique: true, sparse: true },
        email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
        password: { type: String },
        dateEntree: { type: Date },

        actif: { type: Boolean, default: true }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

sousCompteSchema.index({ propriete: 1, numero: 1 }, { unique: true });

// "occupe" : un locataire est attribué ; "libre" : aucun locataire
sousCompteSchema.virtual('statut').get(function () {
    return this.telephone ? 'occupe' : 'libre';
});

module.exports = mongoose.model('SousCompte', sousCompteSchema);
