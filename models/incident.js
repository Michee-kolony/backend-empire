const mongoose = require('mongoose');

// Types d'incidents (valeur stockée -> libellé affiché dans le select)
const TYPES = {
    tentative_intrusion: 'Tentative d\'intrusion',
    intrusion: 'Intrusion',
    vol: 'Vol',
    incendie: 'Incendie',
    accident: 'Accident',
    personne_suspecte: 'Personne suspecte',
    probleme_technique: 'Problème technique',
    urgence_medicale: 'Urgence médicale',
    autre: 'Autre incident'
};

const GRAVITES = {
    faible: 'Faible',
    moyenne: 'Moyenne',
    elevee: 'Élevée',
    critique: 'Critique'
};

// Gravité proposée quand celui qui signale ne la précise pas (l'admin peut la corriger ensuite)
const GRAVITE_PAR_DEFAUT = {
    tentative_intrusion: 'moyenne',
    intrusion: 'critique',
    vol: 'elevee',
    incendie: 'critique',
    accident: 'elevee',
    personne_suspecte: 'moyenne',
    probleme_technique: 'faible',
    urgence_medicale: 'critique',
    autre: 'faible'
};

const STATUTS = {
    nouveau: 'Nouveau',
    en_cours: 'En cours de traitement',
    resolu: 'Résolu',
    classe: 'Classé sans suite'
};

// Modèles qui peuvent signaler un incident
const AUTEURS = ['Gardien', 'Proprietaire', 'Administrateur'];

// Incident signalé par un gardien ou un propriétaire (ou saisi par un admin)
const incidentSchema = new mongoose.Schema(
    {
        type: { type: String, enum: Object.keys(TYPES), required: true },
        description: {
            type: String,
            required: true,
            trim: true,
            minlength: [5, 'La description est trop courte'],
            maxlength: [5000, 'La description ne peut pas dépasser 5000 caractères']
        },

        // Date et heure où l'incident s'est produit (≠ createdAt, la date du signalement)
        dateIncident: { type: Date, required: true, default: Date.now },

        // Position GPS au moment du signalement (facultative)
        position: {
            lat: { type: Number, min: -90, max: 90, default: null },
            lng: { type: Number, min: -180, max: 180, default: null },
            precision: { type: Number, min: 0, default: null } // en mètres, fournie par le téléphone
        },

        photos: { type: [String], default: [] },
        videos: { type: [String], default: [] },

        // Personne ayant signalé l'incident : un gardien, un propriétaire ou un admin
        signalePar: { type: mongoose.Schema.Types.ObjectId, refPath: 'signaleParModele', required: true, immutable: true },
        signaleParModele: { type: String, enum: AUTEURS, required: true, immutable: true },

        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true },
        // Gardien concerné (facultatif quand c'est le propriétaire qui signale)
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', default: null },

        gravite: { type: String, enum: Object.keys(GRAVITES), required: true },

        // Suivi par l'entreprise
        statut: { type: String, enum: Object.keys(STATUTS), default: 'nouveau' },
        traitePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Administrateur', default: null },
        traiteLe: { type: Date, default: null },
        commentaireAdmin: { type: String, trim: true, default: '' }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

incidentSchema.index({ statut: 1, dateIncident: -1 });
incidentSchema.index({ propriete: 1, dateIncident: -1 });
incidentSchema.index({ gardien: 1, dateIncident: -1 });
incidentSchema.index({ signalePar: 1, dateIncident: -1 });

incidentSchema.virtual('typeLibelle').get(function () {
    return TYPES[this.type];
});
incidentSchema.virtual('graviteLibelle').get(function () {
    return GRAVITES[this.gravite];
});
incidentSchema.virtual('statutLibelle').get(function () {
    return STATUTS[this.statut];
});

incidentSchema.statics.TYPES = TYPES;
incidentSchema.statics.GRAVITES = GRAVITES;
incidentSchema.statics.GRAVITE_PAR_DEFAUT = GRAVITE_PAR_DEFAUT;
incidentSchema.statics.STATUTS = STATUTS;

module.exports = mongoose.model('Incident', incidentSchema);
