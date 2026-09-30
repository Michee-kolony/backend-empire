const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

const paiementSchema = new mongoose.Schema(
    {
        propriete: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Propriete',
            required: true
        },
        proprietaire: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Proprietaire',
            required: true
        },
        montant: { type: Number, required: true, min: 0.01 },
        devise: {
            type: String,
            uppercase: true,
            trim: true,
            enum: ['CDF', 'USD'],
            default: 'CDF',
            required: true
        },
        modePaiement: {
            type: String,
            lowercase: true,
            trim: true,
            enum: ['especes', 'mobile_money', 'virement', 'carte', 'cheque', 'autre'],
            required: true
        },
        referenceTransaction: {
            type: String,
            unique: true,
            immutable: true,
            default: () => `REC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().toUpperCase()}`
        },

        // Durée de l'abonnement payé (en mois) : elle fixe la période couverte par ce paiement
        dureeMois: {
            type: Number,
            required: true,
            min: [1, 'La durée doit être d\'au moins 1 mois'],
            validate: {
                validator: Number.isInteger,
                message: 'La durée doit être un nombre entier de mois'
            }
        },
        // Période couverte, calculée par le serveur : periodeFin = periodeDebut + dureeMois
        periodeDebut: { type: Date, required: true },
        periodeFin: {
            type: Date,
            required: true,
            validate: {
                validator: function (dateFin) {
                    return !this.periodeDebut || dateFin > this.periodeDebut;
                },
                message: 'La fin de période doit être postérieure au début'
            }
        },

        // Abonnement de la propriété juste avant ce paiement : remis tel quel si ce paiement est supprimé
        // (null pour les paiements enregistrés avant l'ajout de ce champ)
        abonnementPrecedent: {
            type: new mongoose.Schema(
                {
                    dateDebut: { type: Date, default: null },
                    dateExpiration: { type: Date, default: null },
                    paiement: { type: mongoose.Schema.Types.ObjectId, ref: 'Paiement', default: null }
                },
                { _id: false }
            ),
            default: null
        },

        description: { type: String, trim: true, default: '' },
        adminEnregistreur: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Administrateur',
            required: true,
            immutable: true
        }
    },
    { timestamps: true }
);

paiementSchema.index({ propriete: 1, periodeFin: -1 });

module.exports = mongoose.model('Paiement', paiementSchema);
