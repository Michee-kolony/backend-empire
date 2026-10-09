const mongoose = require('mongoose');

// Délai pendant lequel l'auteur peut corriger ou supprimer un message mal envoyé
const DELAI_MODIFICATION_MINUTES = 15;
const MAX_PHOTOS = 5;

// Message du chat. Rien n'est jamais effacé de la base : une modification garde l'ancienne version
// dans "historique" et une suppression masque seulement le message. Le super administrateur voit
// tout (anciennes versions et messages supprimés) pour empêcher qu'un gardien soit utilisé à de
// mauvaises fins puis que les traces soient effacées.
const messageSchema = new mongoose.Schema(
    {
        conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, immutable: true },

        auteur: { type: mongoose.Schema.Types.ObjectId, refPath: 'auteurModele', required: true, immutable: true },
        auteurModele: { type: String, enum: ['Gardien', 'Proprietaire', 'Administrateur'], required: true, immutable: true },
        // Copie du nom, du rôle et de la photo au moment de l'envoi
        auteurNom: { type: String, required: true, trim: true },
        auteurRole: { type: String, required: true },
        auteurPhoto: { type: String, default: '' },

        contenu: {
            type: String,
            trim: true,
            default: '',
            maxlength: [4000, 'Le message ne peut pas dépasser 4000 caractères']
        },
        photos: {
            type: [String],
            default: [],
            validate: {
                validator: (photos) => photos.length <= MAX_PHOTOS,
                message: `${MAX_PHOTOS} photos maximum par message`
            }
        },

        // Modification par l'auteur
        modifie: { type: Boolean, default: false },
        modifieLe: { type: Date, default: null },
        historique: [{
            _id: false,
            contenu: { type: String, default: '' },
            remplaceLe: { type: Date, required: true }
        }],

        // Suppression (masquée pour les participants, visible par le super administrateur)
        supprime: { type: Boolean, default: false },
        supprimeLe: { type: Date, default: null }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

messageSchema.index({ conversation: 1, createdAt: -1 });

// Un message doit avoir du texte ou au moins une photo
messageSchema.pre('validate', function () {
    if (!this.supprime && !this.contenu && this.photos.length === 0) {
        this.invalidate('contenu', 'Le message doit contenir du texte ou une photo');
    }
});

messageSchema.virtual('modifiableJusqua').get(function () {
    if (!this.createdAt) return null;
    return new Date(this.createdAt.getTime() + DELAI_MODIFICATION_MINUTES * 60000);
});

messageSchema.statics.DELAI_MODIFICATION_MINUTES = DELAI_MODIFICATION_MINUTES;
messageSchema.statics.MAX_PHOTOS = MAX_PHOTOS;

module.exports = mongoose.model('Message', messageSchema);
