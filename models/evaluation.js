const mongoose = require('mongoose');

// Qui peut rédiger une évaluation : le propriétaire ou le gardien (jamais l'administration).
const AUTEURS = ['Proprietaire', 'Gardien'];
const FORMAT_PERIODE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Évaluation mensuelle d'un gardien, liée à une propriété et à un mois ("AAAA-MM").
// Deux évaluations au plus par mois et par (gardien, propriété) : une du propriétaire, une du gardien
// (auto-évaluation). Chacun voit celle de l'autre ; l'administration voit tout.
const evaluationSchema = new mongoose.Schema(
    {
        gardien: { type: mongoose.Schema.Types.ObjectId, ref: 'Gardien', required: true, immutable: true },
        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', required: true, immutable: true },
        // Propriétaire de la propriété au moment de l'évaluation (dénormalisé pour les requêtes)
        proprietaire: { type: mongoose.Schema.Types.ObjectId, ref: 'Proprietaire', required: true, immutable: true },

        // Mois évalué, au format "AAAA-MM"
        periode: { type: String, required: true, immutable: true, match: [FORMAT_PERIODE, 'Période au format AAAA-MM'] },

        // Auteur de cette évaluation : le propriétaire ou le gardien lui-même
        auteur: { type: mongoose.Schema.Types.ObjectId, refPath: 'auteurModele', required: true, immutable: true },
        auteurModele: { type: String, enum: AUTEURS, required: true, immutable: true },
        auteurNom: { type: String, required: true, trim: true },

        commentaire: {
            type: String,
            required: true,
            trim: true,
            minlength: [2, 'L\'appréciation est trop courte'],
            maxlength: [3000, 'L\'appréciation ne peut pas dépasser 3000 caractères']
        },

        modifie: { type: Boolean, default: false },
        modifieLe: { type: Date, default: null }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// Un auteur n'écrit qu'une évaluation par mois et par (gardien, propriété)
evaluationSchema.index({ gardien: 1, propriete: 1, periode: 1, auteurModele: 1 }, { unique: true });
evaluationSchema.index({ proprietaire: 1, periode: -1 });
evaluationSchema.index({ gardien: 1, periode: -1 });

evaluationSchema.statics.AUTEURS = AUTEURS;
evaluationSchema.statics.FORMAT_PERIODE = FORMAT_PERIODE;

module.exports = mongoose.model('Evaluation', evaluationSchema);
