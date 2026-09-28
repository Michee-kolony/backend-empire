const mongoose = require('mongoose');

const proprietaireSchema = new mongoose.Schema(
    {
        nom: {
            type: String,
            required: true,
            trim: true
        },

        postnom: {
            type: String,
            trim: true
        },

        prenom: {
            type: String,
            trim: true
        },

        sexe: {
            type: String,
            enum: ['M', 'F']
        },

        profession: {
            type: String,
            trim: true
        },

        telephone: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },

        email: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            lowercase: true
        },

        password: {
            type: String,
            required: true
        },

        photo: {
            type: String,
            default: null
        },

        adresse: {
            type: String,
            trim: true
        },

       role: { type: String,
       enum: [
        'PROPRIETAIRE',
        'GESTIONNAIRE',
    ],
    default: 'PROPRIETAIRE'
},

        actif: {
            type: Boolean,
            default: true
        },

        dateInscription: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('Proprietaire', proprietaireSchema);