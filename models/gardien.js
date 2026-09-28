const mongoose = require('mongoose');

// Commentaire laissé par un propriétaire sur le gardien
const commentaireSchema = new mongoose.Schema(
    {
        photoProprietaire: {
            type: String,
            default: ''
        },

        nomProprietaire: {
            type: String,
            required: true,
            trim: true
        },

        contenu: {
            type: String,
            required: true,
            trim: true
        },

        dateAjout: {
            type: Date,
            default: Date.now
        }
    }
);

const gardienSchema = new mongoose.Schema(
    {
        // Matricule unique généré automatiquement : empire-XXXXX
        matricule: {
            type: String,
            unique: true,
            immutable: true
        },

        // Informations personnelles
        nom: { type: String, required: true, trim: true },
        postnom: { type: String, required: true, trim: true },
        prenom: { type: String, required: true, trim: true },

        sexe: {
            type: String,
            enum: ['M', 'F'],
            required: true
        },

        dateNaissance: { type: Date, required: true },
        lieuNaissance: { type: String, required: true, trim: true },
        nationalite: { type: String, required: true, trim: true },

        etatCivil: {
            type: String,
            enum: ['celibataire', 'marie', 'divorce', 'veuf'],
            required: true
        },

        photoProfil: { type: String, required: true },

        // Contact
        telephonePrincipal: { type: String, required: true, trim: true },
        telephoneSecondaire: { type: String, trim: true, default: '' },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },

        password: { type: String, required: true },

        // Adresse
        adresseActuelle: { type: String, required: true, trim: true },
        commune: { type: String, required: true, trim: true },
        quartier: { type: String, required: true, trim: true },
        avenue: { type: String, required: true, trim: true },

        statut: {
            type: String,
            enum: ['en service', 'non en service'],
            default: 'non en service'
        },

        coordonnees: {
            lat: { type: Number, default: null },
            lng: { type: Number, default: null }
        },

        commentaires: [commentaireSchema]
    },
    {
        timestamps: true
    }
);

// Génère un matricule aléatoire unique avant la création du gardien
gardienSchema.pre('validate', async function () {
    if (this.matricule) return;

    let matricule;
    do {
        const chiffres = Math.floor(10000 + Math.random() * 90000); // 5 chiffres
        matricule = `empire-${chiffres}`;
    } while (await this.constructor.exists({ matricule }));

    this.matricule = matricule;
});

module.exports = mongoose.model(
    'Gardien',
    gardienSchema
);
