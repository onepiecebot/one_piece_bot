const tmi = require('tmi.js');
const config = require('./config.js');
const { getUsuario, updateUsuario, supabase } = require('./database.js');

// ============================================
// COOLDOWNS
// ============================================
const cooldowns = {};
const COOLDOWN_FRUTA = 3600000; // 1 hora en milisegundos

// ============================================
// ADMIN: Dueño del canal
// ============================================
const DUEÑO = 'fan_d_larana';

function esDueño(username) {
    return username.toLowerCase() === DUEÑO.toLowerCase();
}

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

// ============================================
// FUNCIÓN PARA CALCULAR RESULTADO DE COMBATE
// ============================================
function calcularCombate(nivel, hakiConquistador) {
    const baseExito = [0, 90, 70, 50, 30, 10];
    let exito = baseExito[nivel] || 50;
    const bonus = Math.min(Math.floor(hakiConquistador / 50), 20);
    exito += bonus;
    return Math.random() * 100 < exito;
}

// ============================================
// FUNCIÓN PARA ASIGNAR RECOMPENSAS
// ============================================
function obtenerRecompensas(nivel, resultado) {
    const recompensas = {
        1: { conquistador: 5, berries: 1000000 },
        2: { conquistador: 10, berries: 3000000 },
        3: { conquistador: 15, berries: 5000000 },
        4: { conquistador: 20, berries: 10000000 },
        5: { conquistador: 30, berries: 15000000 }
    };
    const base = recompensas[nivel] || recompensas[1];
    return resultado ? base : {
        conquistador: -Math.floor(base.conquistador / 2),
        berries: -Math.floor(base.berries / 4)
    };
}

// ============================================
// COMANDOS
// ============================================
client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();
    const username = tags.username.toLowerCase();

    // ============================================
    // !infoop
    // ============================================
    if (command === '!infoop') {
        const target = args[1] ? args[1].replace('@', '').toLowerCase() : username;
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
        return;
    }

    // ============================================
    // !op
    // ============================================
    if (command === '!op') {
        const user = await getUsuario(username);
        const armaduraActual = user && user.armadura ? user.armadura : 0;
        await updateUsuario(username, { armadura: armaduraActual + 1 });
        client.say(channel, `@${tags.username} Gracias por interactuar! +1 punto de armadura.`);
        return;
    }

    // ============================================
    // !fruta
    // ============================================
    if (command === '!fruta') {
        const user = await getUsuario(username);

        // Verificar cooldown
        const ahora = Date.now();
        const ultimoUso = cooldowns[`fruta_${username}`] || 0;
        const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
        if (tiempoRestante > 0) {
            const minutos = Math.floor(tiempoRestante / 60000);
            const segundos = Math.floor((tiempoRestante % 60000) / 1000);
            client.say(channel, `@${tags.username} Debes esperar ${minutos} min y ${segundos} seg para usar !fruta nuevamente.`);
            return;
        }

        // Verificar si el usuario está en medio de un evento
        if (user && user.evento_estado === 'pendiente') {
            client.say(channel, `@${tags.username} Ya tienes un evento pendiente. Completa la decisión primero.`);
            return;
        }

        // Verificar si ya tiene fruta
        if (user && user.fruta) {
            client.say(channel, `@${tags.username} Ya tienes una fruta (${user.fruta}). Usa !rechazar si quieres liberarla.`);
            return;
        }

        // Temporal: racha activa para pruebas
        const tieneRacha = true;
        if (!tieneRacha) {
            client.say(channel, `@${tags.username} Necesitas tener la racha activa para buscar una fruta.`);
            return;
        }

        // ============================================
        // 1. Probabilidad general (5%)
        // ============================================
        const probGeneral = 5;
        const randomGeneral = Math.random() * 100;
        if (randomGeneral > probGeneral) {
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

        // ============================================
        // 2. Obtener frutas disponibles
        // ============================================
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
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No hay frutas disponibles en este momento. ¡Vuelve más tarde!`);
            return;
        }

        // ============================================
        // 3. Selección ponderada
        // ============================================
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
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

        // Actualizar cooldown
        cooldowns[`fruta_${username}`] = Date.now();

        // ============================================
        // 4. Verificar si la fruta tiene evento
        // ============================================
        if (selectedFruit.evento) {
            await updateUsuario(username, {
                evento_tipo: 'fruta',
                evento_fase: 'avistamiento',
                evento_fruta: selectedFruit.nombre,
                evento_nivel: selectedFruit.nivel || 1,
                evento_estado: 'pendiente',
                evento_comandos: 'si_no'
            });
            client.say(channel, `@${tags.username} ${selectedFruit.fase1}`);
        } else {
            await updateUsuario(username, { fruta_pendiente: selectedFruit.nombre });
            client.say(channel, `@${tags.username} ${selectedFruit.texto_sin_evento}`);
        }
        return;
    }

    // ============================================
    // !testevento (FORZAR EVENTO DE PRUEBA)
    // ============================================
    if (command === '!testevento') {
        const user = await getUsuario(username);

        // Limpiar cualquier evento pendiente
        await updateUsuario(username, {
            evento_tipo: null,
            evento_fase: null,
            evento_fruta: null,
            evento_nivel: null,
            evento_estado: null,
            evento_comandos: null
        });

        // Obtener la fruta Mera Mera para mostrar su fase1
        const { data: fruta, error } = await supabase
            .from('frutas')
            .select('fase1')
            .eq('nombre', 'Mera Mera no Mi')
            .single();

        if (error || !fruta) {
            client.say(channel, `@${tags.username} Error al cargar el evento de prueba.`);
            console.error('Error al cargar Mera Mera:', error);
            return;
        }

        // Simular que encontró la Mera Mera no Mi (evento)
        await updateUsuario(username, {
            evento_tipo: 'fruta',
            evento_fase: 'avistamiento',
            evento_fruta: 'Mera Mera no Mi',
            evento_nivel: 4,
            evento_estado: 'pendiente',
            evento_comandos: 'si_no'
        });

        client.say(channel, `@${tags.username} [TEST] Has encontrado un evento. ${fruta.fase1}`);
        return;
    }

    // ============================================
    // !si (Fase 1 - Avistamiento)
    // ============================================
    if (command === '!si') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_tipo !== 'fruta' || user.evento_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        await updateUsuario(username, {
            evento_fase: 'encuentro',
            evento_comandos: 'pelear_huir'
        });

        const { data: fruta } = await supabase
            .from('frutas')
            .select('fase2')
            .eq('nombre', user.evento_fruta)
            .single();

        client.say(channel, `@${tags.username} ${fruta.fase2}`);
        return;
    }

    // ============================================
    // !no (Fase 1 - Avistamiento)
    // ============================================
    if (command === '!no') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_tipo !== 'fruta' || user.evento_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        await updateUsuario(username, {
            evento_tipo: null,
            evento_fase: null,
            evento_fruta: null,
            evento_nivel: null,
            evento_estado: null,
            evento_comandos: null
        });

        client.say(channel, `@${tags.username} Decides retirarte. El evento ha terminado.`);
        return;
    }

    // ============================================
    // !pelear (Fase 2 - Encuentro)
    // ============================================
    if (command === '!pelear') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_tipo !== 'fruta' || user.evento_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        const nivel = user.evento_nivel || 1;
        const hakiConquistador = user.conquistador || 0;
        const victoria = calcularCombate(nivel, hakiConquistador);
        const recompensas = obtenerRecompensas(nivel, victoria);

        await updateUsuario(username, {
            conquistador: (user.conquistador || 0) + recompensas.conquistador,
            recompensa_publica: (user.recompensa_publica || 0) + recompensas.berries,
            fruta: victoria ? user.evento_fruta : null,
            evento_tipo: null,
            evento_fase: null,
            evento_fruta: null,
            evento_nivel: null,
            evento_estado: null,
            evento_comandos: null
        });

        if (victoria) {
            client.say(channel, `@${tags.username} ¡Has ganado el combate! Has obtenido la ${user.evento_fruta}. +${recompensas.conquistador} Conquistador, +${recompensas.berries} Berries.`);
        } else {
            client.say(channel, `@${tags.username} Has perdido el combate. No has obtenido la fruta. ${recompensas.conquistador} Conquistador, ${recompensas.berries} Berries.`);
        }
        return;
    }

    // ============================================
    // !huir (Fase 2 - Encuentro)
    // ============================================
    if (command === '!huir') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_tipo !== 'fruta' || user.evento_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        await updateUsuario(username, {
            evento_tipo: null,
            evento_fase: null,
            evento_fruta: null,
            evento_nivel: null,
            evento_estado: null,
            evento_comandos: null
        });

        client.say(channel, `@${tags.username} Has decidido huir. No has obtenido la fruta.`);
        return;
    }

    // ============================================
    // !comer
    // ============================================
    if (command === '!comer') {
        const user = await getUsuario(username);
        if (user && user.fruta_pendiente) {
            const frutaNombre = user.fruta_pendiente;
            const { data: frutaData } = await supabase
                .from('frutas')
                .select('descripcion')
                .eq('nombre', frutaNombre)
                .single();
            const descripcion = frutaData ? frutaData.descripcion : 'humano de algo misterioso';
            await updateUsuario(username, {
                fruta: frutaNombre,
                fruta_pendiente: null
            });
            client.say(channel, `@${tags.username} Has consumido la ${frutaNombre}. Ahora eres un ${descripcion}.`);
        } else {
            client.say(channel, `@${tags.username} FELICIDADES TE COMISTE... ESTA 🫱`);
        }
        return;
    }

    // ============================================
    // !rechazar
    // ============================================
    if (command === '!rechazar') {
        const user = await getUsuario(username);
        if (user && user.fruta_pendiente) {
            const frutaNombre = user.fruta_pendiente;
            await updateUsuario(username, { fruta_pendiente: null });
            client.say(channel, `@${tags.username} Has rechazado la ${frutaNombre}. ¡Quizás la próxima sea mejor!`);
        } else if (user && user.fruta) {
            const frutaNombre = user.fruta;
            await updateUsuario(username, { fruta: null });
            client.say(channel, `@${tags.username} Has rechazado tu fruta (${frutaNombre}). Ahora puedes buscar otra con !fruta.`);
        } else {
            client.say(channel, `@${tags.username} Como te rechazaron toda tu vida, ¿no?`);
        }
        return;
    }

    // ============================================
    // COMANDOS DE ADMIN (SOLO PARA EL DUEÑO)
    // ============================================
    if (!esDueño(username)) return; // Si no es el dueño, ignora todo lo que sigue

    // !sumar1 <usuario> <cantidad> (suma armadura)
    if (command === '!sumar1') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !sumar1 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        await updateUsuario(target, { armadura: (user.armadura || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de armadura a @${target}. Ahora tiene ${user.armadura + cantidad}.`);
        return;
    }

    // !restar1 <usuario> <cantidad> (resta armadura)
    if (command === '!restar1') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !restar1 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        const nuevoValor = Math.max((user.armadura || 0) - cantidad, 0);
        await updateUsuario(target, { armadura: nuevoValor });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de armadura a @${target}. Ahora tiene ${nuevoValor}.`);
        return;
    }

    // !sumar2 <usuario> <cantidad> (suma observacion)
    if (command === '!sumar2') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !sumar2 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        await updateUsuario(target, { observacion: (user.observacion || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de observación a @${target}. Ahora tiene ${user.observacion + cantidad}.`);
        return;
    }

    // !restar2 <usuario> <cantidad> (resta observacion)
    if (command === '!restar2') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !restar2 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        const nuevoValor = Math.max((user.observacion || 0) - cantidad, 0);
        await updateUsuario(target, { observacion: nuevoValor });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de observación a @${target}. Ahora tiene ${nuevoValor}.`);
        return;
    }

    // !sumar3 <usuario> <cantidad> (suma conquistador)
    if (command === '!sumar3') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !sumar3 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        await updateUsuario(target, { conquistador: (user.conquistador || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de conquistador a @${target}. Ahora tiene ${user.conquistador + cantidad}.`);
        return;
    }

    // !restar3 <usuario> <cantidad> (resta conquistador)
    if (command === '!restar3') {
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso correcto: !restar3 @usuario cantidad`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) {
            client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
            return;
        }
        const user = await getUsuario(target);
        const nuevoValor = Math.max((user.conquistador || 0) - cantidad, 0);
        await updateUsuario(target, { conquistador: nuevoValor });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de conquistador a @${target}. Ahora tiene ${nuevoValor}.`);
        return;
    }

    // !quitarfruta <usuario> (quita la fruta a un usuario)
    if (command === '!quitarfruta') {
        if (args.length < 2) {
            client.say(channel, `@${tags.username} Uso correcto: !quitarfruta @usuario`);
            return;
        }
        const target = args[1].replace('@', '').toLowerCase();
        await updateUsuario(target, { fruta: null, fruta_pendiente: null });
        client.say(channel, `@${tags.username} Has quitado la fruta a @${target}.`);
        return;
    }
});

console.log('Bot escuchando...');