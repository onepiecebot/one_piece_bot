const http = require('http');

// 1. Servidor HTTP (para que Render no se queje)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor HTTP funcionando en el puerto ${PORT}`);
});

// 2. Iniciar el bot de Twitch (IMPORTANTE)
console.log('Intentando iniciar el bot de Twitch...');
require('./bot.js');