const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

const app = express();

// Connexion à MongoDB
mongoose.connect('mongodb://micheekolony71%40gmail.com:1708roosevelt@187.7.27.156:27017/empire?authSource=admin')
    .then(() => console.log('Connexion à MongoDB réussie ✅'))
    .catch((error) => console.error('Connexion à MongoDB échouée ❌ :', error.message));

// CORS : autorise les requêtes venant du frontend
app.use(cors({
    origin: '*', // à remplacer par l'URL du frontend en production (ex: 'http://localhost:3000')
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body-parser : lit le corps des requêtes JSON et des formulaires
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Route de test
app.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'API fonctionne correctement 🚀',
        timestamp: new Date()
    });
});

// Routes
app.use('/api/admins', require('./routes/admin'));
app.use('/api/gardiens', require('./routes/gardien'));
app.use('/api/proprietaires', require('./routes/proprietaire'));
app.use('/api/proprietes', require('./routes/propriete'));
app.use('/api/paiements', require('./routes/paiement'));

// Route introuvable
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route introuvable' });
});

module.exports = app;
