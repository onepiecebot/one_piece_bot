const tmi = require('tmi.js');
const config = require('./config.js');
const { getUsuario, updateUsuario } = require('./database.js');

const client = new tmi.Client({
    identity: {
        username: config.botName,
        password: config.oauth
    },
    channels: [config.channelName]
});

client.connect().then(() => {
    console.log(`Bot conectado como ${config.botName} en el canal #${config.channelName}`);
}).catch(err => console.error('Error al conectar:', err));

client.on('message', (channel, tags, message, self) => {
    if (self) return;
    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command === '!infoop') {
        const target = args[1] ? args[1].replace('@', '').toLowerCase() : tags.username.toLowerCase();
        const user = getUsuario(target);
        
        const rango = (pts) => {
            if (pts <= 0) return 'No despertado';
            if (pts <= 49) return 'Despertado';
            if (pts <= 79) return 'Basico';
            if (pts <= 99) return 'Avanzado';
            return 'Supremo';
        };

        const fruta = user.fruta || 'Ninguna';
        const respuesta = `@${target} | Fruta: ${fruta} | Haki Armadura: ${rango(user.armadura)} | Haki Observacion: ${rango(user.observacion)} | Haki Conquistador: ${rango(user.conquistador)}`;
        client.say(channel, respuesta);
    }

    if (command === '!op') {
        const user = getUsuario(tags.username.toLowerCase());
        updateUsuario(tags.username.toLowerCase(), { armadura: user.armadura + 1 });
        client.say(channel, `@${tags.username} Gracias por interactuar! +1 punto de armadura.`);
    }

    if (command === '!fruta') {
        client.say(channel, `@${tags.username} El sistema de frutas esta en desarrollo. Vuelve pronto!`);
    }

    if (command === '!rechazar') {
        client.say(channel, `@${tags.username} Funcion de rechazo aun no implementada.`);
    }
});

console.log('Bot escuchando...');