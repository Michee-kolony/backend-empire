const mongoose = require('mongoose');

const UNITES_DUREE = ['jours', 'semaines', 'mois'];

// Affectation d'un gardien à une propriété pour une durée choisie par l'admin.
// Une propriété peut avoir plusieurs gardiens en même temps, dont un seul gardien principal.
const affectationSchema = new mongoose.Schema(
    {
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', required: true },

        estPrincipal: { type: Boolean, default: false },

        // Durée choisie par l'admin : dateFin = dateDebut + duree (en uniteDuree), calculée par le serveur
        duree: {
            type: Number,
            required: true,
            min: [1, 'La durée doit être d\'au moins 1'],
            validate: {
                validator: Number.isInteger,
                message: 'La durée doit être un nombre entier'
            }
        },
        uniteDuree: { type: String, enum: UNITES_DUREE, default: 'mois', required: true },
        dateDebut: { type: Date, required: true },
        dateFin: {
            type: Date,
            required: true,
            validate: {
                validator: function (dateFin) {
                    return !this.dateDebut || dateFin > this.dateDebut;
                },
                message: 'La date de fin doit être postérieure à la date de début'
            }
        },

        // Renseigné quand l'admin met fin à l'affectation avant son terme
        termineeLe: { type: Date, default: null },

        description: { type: String, trim: true, default: '' },
        adminEnregistreur: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Administrateur',
            required: true,
            immutable: true
        }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

affectationSchema.index({ propriete: 1, dateFin: -1 });
affectationSchema.index({ gardien: 1, dateFin: -1 });

// "en cours" : période en cours ; "expiree" : date de fin atteinte ; "a venir" : date de début pas encore atteinte
affectationSchema.virtual('statut').get(function () {
    const maintenant = new Date();
    if (this.dateFin <= maintenant) return 'expiree';
    if (this.dateDebut > maintenant) return 'a venir';
    return 'en cours';
});

// Filtre MongoDB équivalent au statut (le statut n'est pas stocké, il dépend de la date du jour)
affectationSchema.statics.filtreStatut = (statut, maintenant = new Date()) => {
    if (statut === 'expiree') return { dateFin: { $lte: maintenant } };
    if (statut === 'a venir') return { dateDebut: { $gt: maintenant } };
    if (statut === 'en cours') return { dateDebut: { $lte: maintenant }, dateFin: { $gt: maintenant } };
    return null;
};

affectationSchema.statics.UNITES_DUREE = UNITES_DUREE;

module.exports = mongoose.model('Affectation', affectationSchema);
