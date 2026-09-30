const mongoose = require('mongoose');
const { JOURS } = require('../utils/horaires');

const UNITES_DUREE = ['jours', 'semaines', 'mois'];
const ROLES = ['principal', 'remplacant'];
const FORMAT_HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Affectation d'un gardien à une propriété pour une durée choisie par l'admin.
// Une propriété peut avoir plusieurs gardiens en même temps : un seul principal, les autres remplaçants.
const affectationSchema = new mongoose.Schema(
    {
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', required: true },

        role: { type: String, enum: ROLES, default: 'remplacant', required: true },

        // Horaires de service au format HH:mm. Heure de fin < heure de début : le service passe minuit (18:00 -> 06:00)
        heureDebut: { type: String, match: [FORMAT_HEURE, 'Heure de début invalide (HH:mm)'], default: null },
        heureFin: { type: String, match: [FORMAT_HEURE, 'Heure de fin invalide (HH:mm)'], default: null },

        // Jours où le service commence
        joursService: {
            type: [{ type: String, enum: JOURS }],
            default: () => [...JOURS],
            validate: {
                validator: (jours) => jours.length > 0 && new Set(jours).size === jours.length,
                message: 'Au moins un jour de service, sans doublon'
            }
        },

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
                    return !this.dateDebut || dateFin >= this.dateDebut;
                },
                message: 'La date de fin doit être postérieure à la date de début'
            }
        },

        // Retrait du gardien avant la fin prévue (retrait simple ou remplacement)
        retireLe: { type: Date, default: null },
        motifRetrait: { type: String, trim: true, default: '' },
        retirePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Administrateur', default: null },

        // Chaîne de remplacement : l'affectation remplacée et celle qui l'a remplacée
        remplace: { type: mongoose.Schema.Types.ObjectId, ref: 'Affectation', default: null },
        remplacePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Affectation', default: null },

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

// "en cours" : période en cours ; "expiree" : date de fin atteinte (ou gardien retiré) ; "a venir" : pas encore commencée
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

// Reprend les affectations créées avant l'ajout des rôles et du retrait (estPrincipal, termineeLe)
affectationSchema.statics.migrerAnciennesAffectations = async function () {
    const collection = this.collection;
    await collection.updateMany({ role: { $exists: false }, estPrincipal: true }, { $set: { role: 'principal' } });
    await collection.updateMany({ role: { $exists: false } }, { $set: { role: 'remplacant' } });
    await collection.updateMany({ termineeLe: { $ne: null, $exists: true } }, [{ $set: { retireLe: '$termineeLe' } }]);
    await collection.updateMany(
        { $or: [{ estPrincipal: { $exists: true } }, { termineeLe: { $exists: true } }] },
        { $unset: { estPrincipal: '', termineeLe: '' } }
    );
    await collection.updateMany({ joursService: { $exists: false } }, { $set: { joursService: JOURS } });
};

affectationSchema.statics.UNITES_DUREE = UNITES_DUREE;
affectationSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('Affectation', affectationSchema);
