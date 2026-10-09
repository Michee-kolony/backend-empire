const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

// Salons Socket.IO :
// - "utilisateur:<id>" : chaque compte connecté
// - "admins"           : tous les administrateurs (ADMIN et SUPER_ADMIN)
// - "supervision"      : super administrateurs, reçoivent tous les messages en version complète
const salonUtilisateur = (id) => `utilisateur:${id}`;
const SALON_ADMINS = 'admins';
const SALON_SUPERVISION = 'supervision';

let io = null;

const init = (server) => {
    io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });

    // Le client se connecte avec : io(URL, { auth: { token } })
    io.use((socket, next) => {
        const brut = socket.handshake.auth?.token || socket.handshake.headers.authorization || '';
        const token = brut.startsWith('Bearer ') ? brut.slice(7) : brut;
        try {
            socket.data.utilisateur = jwt.verify(token, JWT_SECRET);
            next();
        } catch (error) {
            next(new Error('Token invalide ou expiré'));
        }
    });

    io.on('connection', (socket) => {
        const { id, role } = socket.data.utilisateur;
        socket.join(salonUtilisateur(id));
        if (ROLES_ADMIN.includes(role)) socket.join(SALON_ADMINS);
        if (role === 'SUPER_ADMIN') socket.join(SALON_SUPERVISION);

        // Indicateur "en train d'écrire" : { conversation }
        socket.on('chat:ecrit', async (donnees) => {
            try {
                await require('../controllers/chat').signalerEcriture(socket.data.utilisateur, donnees?.conversation);
            } catch (error) {
                // Conversation inaccessible : on ignore
            }
        });

        socket.on('disconnect', () => {});
    });

    return io;
};

// Envoie un événement aux salons indiqués. Les super admins reçoivent la version "supervision"
// (avec historique et messages supprimés), les autres la version publique.
const emettre = (salons, evenement, donneesPubliques, donneesSupervision = donneesPubliques) => {
    if (!io) return;
    if (salons.length > 0) io.to(salons).except(SALON_SUPERVISION).emit(evenement, donneesPubliques);
    io.to(SALON_SUPERVISION).emit(evenement, donneesSupervision);
};

// Comme emettre, sans prévenir la supervision (ex : "en train d'écrire")
const emettreSansSupervision = (salons, evenement, donnees, exceptId) => {
    if (!io || salons.length === 0) return;
    let cible = io.to(salons);
    if (exceptId) cible = cible.except(salonUtilisateur(exceptId));
    cible.emit(evenement, donnees);
};

module.exports = { init, emettre, emettreSansSupervision, salonUtilisateur, SALON_ADMINS, SALON_SUPERVISION };
