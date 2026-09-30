const mongoose = require('mongoose');

// Au-delà de ce délai après la fin prévue, un service jamais clôturé est considéré "non cloture"
const DELAI_NON_CLOTURE_MINUTES = 120;

const positionSchema = new mongoose.Schema(
    {
        lat: { type: Number, min: -90, max: 90, required: true },
        lng: { type: Number, min: -180, max: 180, required: true },
        // Précision du GPS du téléphone, en mètres (si fournie)
        precision: { type: Number, min: 0, default: null },
        // Distance jusqu'à la propriété, en mètres (null si la propriété n'a pas de coordonnées)
        distanceMetres: { type: Number, min: 0, default: null },
        horsZone: { type: Boolean, default: false }
    },
    { _id: false }
);

// Un service réellement effectué par un gardien (pointage d'arrivée puis de départ)
const presenceSchema = new mongoose.Schema(
    {
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', required: true },
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },
        affectation: { type: mongoose.Schema.Types.ObjectId, ref: 'Affectation', required: true },

        // Jour local du service prévu ("AAAA-MM-JJ") : un service de nuit 18:00 -> 06:00 garde le jour de son début
        jourService: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        debutPrevu: { type: Date, required: true },
        finPrevue: { type: Date, required: true },

        // Début du service
        heureArrivee: { type: Date, required: true },
        positionArrivee: { type: positionSchema, required: true },
        // Minutes après le début prévu (0 si à l'heure ou en avance)
        retardMinutes: { type: Number, min: 0, default: 0 },
        enRetard: { type: Boolean, default: false },

        // Fin du service
        heureDepart: { type: Date, default: null },
        positionDepart: { type: positionSchema, default: null },
        dureeMinutes: { type: Number, min: 0, default: null },
        // Minutes avant la fin prévue (0 si parti à l'heure ou après)
        departAnticipeMinutes: { type: Number, min: 0, default: 0 },

        // Clôture faite par un admin ou automatiquement (gardien qui a oublié de pointer son départ)
        cloture: { type: String, enum: ['gardien', 'admin', 'automatique'], default: null },
        cloturePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Administrateur', default: null },
        commentaire: { type: String, trim: true, default: '' }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// Un seul pointage par service prévu
presenceSchema.index({ affectation: 1, jourService: 1 }, { unique: true });
presenceSchema.index({ gardien: 1, heureArrivee: -1 });
presenceSchema.index({ propriete: 1, heureArrivee: -1 });

const limiteNonCloture = (maintenant = new Date()) => new Date(maintenant.getTime() - DELAI_NON_CLOTURE_MINUTES * 60000);

// "en cours" : gardien sur place ; "termine" : départ pointé ; "non cloture" : départ jamais pointé
presenceSchema.virtual('statut').get(function () {
    if (this.heureDepart) return 'termine';
    return this.finPrevue <= limiteNonCloture() ? 'non cloture' : 'en cours';
});

presenceSchema.statics.filtreStatut = (statut, maintenant = new Date()) => {
    if (statut === 'termine') return { heureDepart: { $ne: null } };
    if (statut === 'en cours') return { heureDepart: null, finPrevue: { $gt: limiteNonCloture(maintenant) } };
    if (statut === 'non cloture') return { heureDepart: null, finPrevue: { $lte: limiteNonCloture(maintenant) } };
    return null;
};

module.exports = mongoose.model('Presence', presenceSchema);
