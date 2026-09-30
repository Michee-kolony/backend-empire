const mongoose = require('mongoose');

// Objets possibles d'un rapport (valeur stockée -> libellé affiché dans le select)
const OBJETS = {
    simple: 'Rapport simple',
    incident: 'Incident',
    maltraitance: 'Maltraitance',
    vol: 'Vol',
    intrusion: 'Intrusion',
    degat: 'Dégât matériel',
    panne: 'Panne / problème technique',
    autre: 'Autre'
};

const STATUTS = ['nouveau', 'lu', 'traite'];

// Rapport écrit par un gardien après (ou pendant) son service
const rapportSchema = new mongoose.Schema(
    {
        // Le nom et la photo de profil du gardien sont renvoyés via populate('gardien')
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', required: true, immutable: true },
        // Propriété où il était affecté, et le service concerné
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true, immutable: true },
        affectation: { type: mongoose.Schema.Types.ObjectId, ref: 'Affectation', required: true, immutable: true },
        presence: { type: mongoose.Schema.Types.ObjectId, ref: 'Presence', required: true, immutable: true },

        objet: { type: String, enum: Object.keys(OBJETS), required: true },
        description: {
            type: String,
            required: true,
            trim: true,
            minlength: [5, 'La description est trop courte'],
            maxlength: [5000, 'La description ne peut pas dépasser 5000 caractères']
        },

        // Suivi par l'entreprise
        statut: { type: String, enum: STATUTS, default: 'nouveau' },
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

rapportSchema.index({ gardien: 1, createdAt: -1 });
rapportSchema.index({ propriete: 1, createdAt: -1 });
rapportSchema.index({ statut: 1, createdAt: -1 });

rapportSchema.virtual('objetLibelle').get(function () {
    return OBJETS[this.objet];
});

rapportSchema.statics.OBJETS = OBJETS;
rapportSchema.statics.STATUTS = STATUTS;

module.exports = mongoose.model('Rapport', rapportSchema);
