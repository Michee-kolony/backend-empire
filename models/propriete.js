const mongoose = require('mongoose');

const proprieteSchema = new mongoose.Schema(
    {
        // Propriétaire de cette propriété (compte Proprietaire)
        proprietaire: { type: mongoose.Schema.Types.ObjectId, ref: 'Proprietaire', required: true },

        // Identification de la propriété
        nomReference: { type: String, required: true, trim: true },

        typePropriete: {
            type: String,
            lowercase: true,
            trim: true,
            enum: ['maison', 'villa', 'appartement', 'immeuble', 'bureau', 'commerce', 'autre'],
            required: true
        },

        // Précision si typePropriete = "autre"
        typeAutre: { type: String, trim: true, default: '' },

        numeroParcelle: { type: String, trim: true, default: '' },
        nombreBatiments: { type: Number, min: 0, default: null },
        nombreNiveaux: { type: Number, min: 0, default: null },

        // Localisation
        commune: { type: String, required: true, trim: true },
        quartier: { type: String, required: true, trim: true },
        avenue: { type: String, required: true, trim: true },
        numero: { type: String, trim: true, default: '' },
        referenceComplementaire: { type: String, trim: true, default: '' },

        coordonnees: {
            lat: { type: Number, min: -90, max: 90, default: null },
            lng: { type: Number, min: -180, max: 180, default: null }
        },

        // Lien de localisation sur carte (ex : Google Maps)
        lienCarte: { type: String, trim: true, default: '' },

        // Description
        nombreChambres: { type: Number, min: 0, default: null },
        nombrePortesAcces: { type: Number, min: 0, default: null },
        cloture: { type: Boolean, default: false },
        portail: { type: Boolean, default: false },
        garage: { type: Boolean, default: false },
        nombreVehicules: { type: Number, min: 0, default: null },
        autresInformations: { type: String, trim: true, default: '' },

        // Sécurité
        niveauSecurite: {
            type: String,
            lowercase: true,
            trim: true,
            enum: ['standard', 'renforce', 'haute surveillance'],
            default: 'standard'
        },
        cameras: { type: Boolean, default: false },
        nombreCameras: { type: Number, min: 0, default: 0 },
        alarme: { type: Boolean, default: false },
        eclairageSecurite: { type: Boolean, default: false },
        interphone: { type: Boolean, default: false },
        autresEquipementsSecurite: { type: String, trim: true, default: '' },

        // Abonnement : ces dates ne sont jamais saisies directement,
        // elles sont fixées par le paiement qui couvre la période (voir controllers/paiement.js)
        dernierPaiement: { type: mongoose.Schema.Types.ObjectId, ref: 'Paiement', default: null },
        dateDebutAbonnement: { type: Date, default: null },
        dateExpirationAbonnement: {
            type: Date,
            default: null,
            validate: {
                validator: function (dateExpiration) {
                    return !dateExpiration || !this.dateDebutAbonnement || dateExpiration > this.dateDebutAbonnement;
                },
                message: "La date d'expiration doit être après la date de début de l'abonnement"
            }
        },

        // Documents / preuves (URLs dans le bucket)
        photos: {
            type: [String],
            validate: {
                validator: (photos) => photos.length <= 5,
                message: '5 photos maximum'
            }
        },
        documentPropriete: { type: String, default: null },
        autresDocuments: { type: [String], default: [] }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// "actif" : abonnement en cours ; "expire" : date d'expiration dépassée ; "aucun" : jamais payé
proprieteSchema.virtual('statutAbonnement').get(function () {
    if (!this.dateExpirationAbonnement) return 'aucun';
    return this.dateExpirationAbonnement > new Date() ? 'actif' : 'expire';
});

module.exports = mongoose.model('Propriete', proprieteSchema);
