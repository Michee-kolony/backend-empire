const http = require('http');
const app = require('./app');
const socket = require('./utils/socket');

const server = http.createServer(app);

// Socket.IO (chat en temps réel), authentifié par le même token JWT que l'API
socket.init(server);

server.listen(3000, () => {
    console.log('Serveur Socket.IO démarré sur le port 3000');
});
