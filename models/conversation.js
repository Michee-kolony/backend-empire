const mongoose = require('mongoose');

const TYPES = {
    propriete: 'Discussion de la propriété', // propriétaire + gardiens affectés + administrateurs
    directe: 'Discussion privée'             // entre deux personnes
};

const MODELES = ['Gardien', 'Proprietaire', 'Administrateur'];

// Conversation du chat.
// - "propriete" : une seule par propriété. Les membres ne sont pas stockés, ils sont recalculés à chaque
//   requête (propriétaire, gardiens en service sur la propriété, administrateurs) : un gardien retiré
//   perd automatiquement l'accès.
// - "directe" : deux participants fixes.
// Le super administrateur peut lire toutes les conversations (supervision).
const conversationSchema = new mongoose.Schema(
    {
        type: { type: String, enum: Object.keys(TYPES), required: true, immutable: true },

        propriete: { type: mongoose.Schema.Types.ObjectId, ref: 'Propriete', default: null, immutable: true },

        participants: [{
            _id: false,
            utilisateur: { type: mongoose.Schema.Types.ObjectId, refPath: 'participants.modele', required: true },
            modele: { type: String, enum: MODELES, required: true }
        }],

        // "<id1>_<id2>" triés : empêche d'ouvrir deux conversations directes entre les mêmes personnes
        cleDirecte: { type: String, default: undefined, immutable: true },

        // Aperçu pour la liste des conversations
        dernierMessage: {
            contenu: { type: String, default: '' },
            auteurNom: { type: String, default: '' },
            date: { type: Date, default: null }
        },

        // Dernière lecture de chaque utilisateur (pour les messages non lus)
        lectures: [{
            _id: false,
            utilisateur: { type: mongoose.Schema.Types.ObjectId, required: true },
            date: { type: Date, required: true }
        }],

        creePar: { type: mongoose.Schema.Types.ObjectId, refPath: 'creeParModele', required: true, immutable: true },
        creeParModele: { type: String, enum: MODELES, required: true, immutable: true }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

conversationSchema.index(
    { propriete: 1 },
    { unique: true, partialFilterExpression: { type: 'propriete' } }
);
conversationSchema.index(
    { cleDirecte: 1 },
    { unique: true, partialFilterExpression: { type: 'directe' } }
);
conversationSchema.index({ 'participants.utilisateur': 1, 'dernierMessage.date': -1 });
conversationSchema.index({ 'dernierMessage.date': -1 });

conversationSchema.virtual('typeLibelle').get(function () {
    return TYPES[this.type];
});

conversationSchema.statics.TYPES = TYPES;
conversationSchema.statics.MODELES = MODELES;
conversationSchema.statics.cleDirecte = (idA, idB) => [String(idA), String(idB)].sort().join('_');

module.exports = mongoose.model('Conversation', conversationSchema);
