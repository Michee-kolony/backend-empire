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
        datePaiement: { type: Date, default: Date.now, required: true },
        referenceTransaction: {
            type: String,
            unique: true,
            immutable: true,
            default: () => `REC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().toUpperCase()}`
        },
        periodeDebut: { type: Date, default: null },
        periodeFin: {
            type: Date,
            default: null,
            validate: {
                validator: function (dateFin) {
                    return !dateFin || !this.periodeDebut || dateFin >= this.periodeDebut;
                },
                message: 'La fin de période doit être postérieure ou égale au début'
            }
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

module.exports = mongoose.model('Paiement', paiementSchema);