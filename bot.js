const tmi = require('tmi.js');
const config = require('./config.js');
const { getUsuario, updateUsuario, supabase } = require('./database.js');

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

client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command === '!infoop') {
        const target = args[1] ? args[1].replace('@', '').toLowerCase() : tags.username.toLowerCase();
        const user = await getUsuario(target);
        
        const rango = (pts) => {
            if (pts <= 0) return 'No despertado';
            if (pts <= 49) return 'Despertado';
            if (pts <= 79) return 'Basico';
            if (pts <= 99) return 'Avanzado';
            return 'Supremo';
        };

        const fruta = user && user.fruta ? user.fruta : 'Ninguna';
        const respuesta = `@${target} | Fruta: ${fruta} | Haki Armadura: ${rango(user && user.armadura ? user.armadura : 0)} | Haki Observacion: ${rango(user && user.observacion ? user.observacion : 0)} | Haki Conquistador: ${rango(user && user.conquistador ? user.conquistador : 0)}`;
        client.say(channel, respuesta);
    }

    if (command === '!op') {
        const user = await getUsuario(tags.username.toLowerCase());
        const armaduraActual = user && user.armadura ? user.armadura : 0;
        await updateUsuario(tags.username.toLowerCase(), { armadura: armaduraActual + 1 });
        client.say(channel, `@${tags.username} Gracias por interactuar! +1 punto de armadura.`);
    }

    if (command === '!fruta') {
        const user = await getUsuario(tags.username.toLowerCase());

        // Temporal: racha activa para pruebas
        const tieneRacha = true;
        if (!tieneRacha) {
            client.say(channel, `@${tags.username} Necesitas tener la racha activa para buscar una fruta.`);
            return;
        }

        if (user && user.fruta) {
            client.say(channel, `@${tags.username} Ya tienes la fruta ${user.fruta}. Usa !rechazar si quieres intentar conseguir otra.`);
            return;
        }

        if (user && user.fruta_pendiente) {
            client.say(channel, `@${tags.username} Ya tienes una fruta pendiente (${user.fruta_pendiente}). Decide con !comer o !rechazar.`);
            return;
        }

        // Obtener frutas disponibles
        const { data: usuariosConFruta, error: errorUsuarios } = await supabase
            .from('usuarios')
            .select('fruta')
            .not('fruta', 'is', null);

        if (errorUsuarios) {
            console.error('Error al obtener usuarios con fruta:', errorUsuarios);
            client.say(channel, `@${tags.username} Hubo un error. Intenta de nuevo.`);
            return;
        }

        const frutasOcupadas = usuariosConFruta.map(u => u.fruta);
        const { data: frutasDisponibles, error: errorFrutas } = await supabase
            .from('frutas')
            .select('*')
            .not('nombre', 'in', `(${frutasOcupadas.map(f => `'${f}'`).join(',')})`);

        if (errorFrutas) {
            console.error('Error al obtener frutas:', errorFrutas);
            client.say(channel, `@${tags.username} Hubo un error. Intenta de nuevo.`);
            return;
        }

        if (!frutasDisponibles || frutasDisponibles.length === 0) {
            client.say(channel, `@${tags.username} No hay frutas disponibles en este momento. ¡Vuelve más tarde!`);
            return;
        }

        // Selección ponderada
        const totalProb = frutasDisponibles.reduce((sum, f) => sum + f.probabilidad, 0);
        let randomPick = Math.random() * totalProb;
        let selectedFruit = null;
        for (const fruta of frutasDisponibles) {
            randomPick -= fruta.probabilidad;
            if (randomPick <= 0) {
                selectedFruit = fruta;
                break;
            }
        }

        if (!selectedFruit) {
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

        // Guardar fruta pendiente
        await updateUsuario(tags.username.toLowerCase(), { fruta_pendiente: selectedFruit.nombre });
        console.log(`?? Fruta pendiente guardada para ${tags.username}: ${selectedFruit.nombre}`);

        client.say(channel, `@${tags.username} ¡Has encontrado una fruta! Es la ${selectedFruit.nombre}: ${selectedFruit.descripcion}. ¿Qué decisión tomas? !comer o !rechazar. Recuerda que solo puedes consumir una fruta...`);
    }

    if (command === '!comer') {
        const user = await getUsuario(tags.username.toLowerCase());

        if (user && user.fruta_pendiente) {
            const frutaNombre = user.fruta_pendiente;

            const { data: frutaData, error } = await supabase
                .from('frutas')
                .select('descripcion')
                .eq('nombre', frutaNombre)
                .single();

            const descripcion = frutaData ? frutaData.descripcion : 'humano de algo misterioso';

            await updateUsuario(tags.username.toLowerCase(), {
                fruta: frutaNombre,
                fruta_pendiente: null
            });

            client.say(channel, `@${tags.username} ¡Has consumido la ${frutaNombre}! Ahora eres un ${descripcion}.`);
        } else {
            client.say(channel, `@${tags.username} FELICIDADES TE COMISTE... ESTA ??`);
        }
    }

    if (command === '!rechazar') {
        const user = await getUsuario(tags.username.toLowerCase());

        if (user && user.fruta_pendiente) {
            const frutaNombre = user.fruta_pendiente;

            await updateUsuario(tags.username.toLowerCase(), { fruta_pendiente: null });
            client.say(channel, `@${tags.username} Has rechazado la ${frutaNombre}. ¡Quizás la próxima sea mejor!`);
        } else if (user && user.fruta) {
            const frutaNombre = user.fruta;
            await updateUsuario(tags.username.toLowerCase(), { fruta: null });
            client.say(channel, `@${tags.username} Has rechazado tu fruta (${frutaNombre}). Ahora puedes buscar otra con !fruta.`);
        } else {
            client.say(channel, `@${tags.username} Como te rechazaron toda tu vida, ¿no?`);
        }
    }
});

console.log('Bot escuchando...');