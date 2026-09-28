const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { appendFile } = require('fs');

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    console.log('Client connecté :', socket.id);

    socket.on('disconnect', () => {
        console.log('Client déconnecté :', socket.id);
    });
});

server.listen(3000, () => {
    console.log('Serveur Socket.IO démarré sur le port 3000');
});