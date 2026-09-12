const tmi = require('tmi.js');
const WebSocket = require('ws');
const config = require('./config.js');
const { getUsuario, updateUsuario, supabase } = require('./database.js');

// ============================================
// CONSTANTES
// ============================================
const COOLDOWN_FRUTA = 60000;
const PROB_FRUTA = 100;
const DUEÑO = 'fan_d_larana';
const TWITCH_API_URL = 'https://api.twitch.tv/helix';

// ============================================
// COOLDOWNS
// ============================================
const cooldowns = {};

// ============================================
// FUNCIONES DE FECHA
// ============================================
function getFechaOffset(diasOffset = 0) {
    const ahora = new Date();
    ahora.setDate(ahora.getDate() + diasOffset);
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    return arg.toISOString().split('T')[0];
}

const getFechaHoy = () => getFechaOffset(0);
const getFechaAyer = () => getFechaOffset(-1);

// ============================================
// RANGOS Y TIRADAS
// ============================================
function getRangoArmadura(puntos, esSupremo = false) {
    if (esSupremo) return { nombre: 'Supremo', factor: 1.0, emoji: '👑' };
    if (puntos >= 100) return { nombre: 'Avanzado Élite', factor: 0.8, emoji: '🔥' };
    if (puntos >= 80) return { nombre: 'Avanzado', factor: 0.8, emoji: '🔥' };
    if (puntos >= 50) return { nombre: 'Básico', factor: 0.5, emoji: '💪' };
    if (puntos >= 20) return { nombre: 'Despertado', factor: 0.2, emoji: '💡' };
    return { nombre: 'No despertado', factor: 0, emoji: '❌' };
}

function getIntervaloTirada(rango) {
    const intervalos = {
        'No despertado': { min: 1, max: 5 },
        'Despertado': { min: -1, max: 4 },
        'Básico': { min: -2, max: 3 },
        'Avanzado': { min: -3, max: 4 },
        'Avanzado Élite': { min: -3, max: 3 },
        'Supremo': { min: -4, max: 2 }
    };
    return intervalos[rango] || { min: 0, max: 0 };
}

const tiradaAleatoria = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ============================================
// EMOJIS DE RANGO
// ============================================
function getEmojiRango(puntos, tipo = 'armadura', esSupremo = false) {
    if (tipo === 'conquistador') {
        if (puntos > 100) return '👑';
        if (puntos >= 95) return '🔥';
        if (puntos >= 80) return '💪';
        if (puntos >= 50) return '💡';
        return '❌';
    }
    if (tipo === 'armadura' && esSupremo) return '👑';
    if (puntos >= 100) return '👑';
    if (puntos >= 80) return '🔥';
    if (puntos >= 50) return '💪';
    if (puntos >= 20) return '💡';
    return '❌';
}

function getCalaveras(nivel) {
    return '💀'.repeat(Math.min(Math.max(nivel, 1), 5));
}

// ============================================
// BONUS Y TEXTOS
// ============================================
function getBonusDiario(rango) {
    const bonuses = {
        'No despertado': 5, 'Despertado': 4, 'Básico': 3,
        'Avanzado': 2, 'Avanzado Élite': 2, 'Supremo': 1
    };
    return bonuses[rango] || 0;
}

function getBonusRacha(dias) {
    if (dias % 10 === 0) return 10;
    if (dias % 5 === 0) return 5;
    return 1;
}

function getTextoResultado(rango, delta) {
    const textos = {
        positivo: {
            'No despertado': '¡Sentís una chispa interior!',
            'Despertado': '¡Tu espíritu se enciende!',
            'Básico': '¡Tu cuerpo se vuelve más duro!',
            'Avanzado': '¡Tu voluntad es inquebrantable!',
            'Avanzado Élite': '¡Tu voluntad es inquebrantable!',
            'Supremo': '¡Nadie puede detenerte!'
        },
        negativo: {
            'No despertado': 'Tu Haki se resiste...',
            'Despertado': 'El entrenamiento fue duro...',
            'Básico': 'Golpeaste mal y perdiste fuerza...',
            'Avanzado': 'Tu Armadura flaqueó un instante...',
            'Avanzado Élite': 'Tu Armadura flaqueó un instante...',
            'Supremo': 'Hasta los más fuertes fallan...'
        },
        neutro: {
            'No despertado': 'Nada cambió... pero no te rindas.',
            'Despertado': 'Tu Haki está estable.',
            'Básico': 'Hoy no hubo cambios, pero seguís firme.',
            'Avanzado': 'Nada te mueve, ni siquiera la suerte.',
            'Avanzado Élite': 'Nada te mueve, ni siquiera la suerte.',
            'Supremo': 'Nada puede tocarte, ni el azar.'
        }
    };
    const tipo = delta > 0 ? 'positivo' : delta < 0 ? 'negativo' : 'neutro';
    return textos[tipo][rango] || 'Sin cambios.';
}

function getMensajeNuevoRango(rango, usuario) {
    const mensajes = {
        'Despertado': `💡 ¡Felicidades ${usuario}! Tu Haki de Armadura ha despertado.`,
        'Básico': `💪 ¡Tu defensa se vuelve confiable, ${usuario}! Nivel Básico alcanzado.`,
        'Avanzado': `🔥 ¡Impresionante, ${usuario}! Tu Armadura tiene gran poder. Rango Avanzado.`,
        'Supremo': `👑 ¡Como un emperador del mar, ${usuario} ha dominado el Haki de Armadura! Ahora es SUPREMO.`
    };
    return mensajes[rango] || '';
}

// ============================================
// CÁLCULO DE RECOMPENSA (PROVISIONAL)
// ============================================
function calcularRecompensa(user) {
    const arm = user.armadura || 0;
    const obs = user.observacion || 0;
    const conq = user.conquistador || 0;
    const tieneFruta = user.fruta ? 1 : 0;
    return (arm * 500000) + (obs * 500000) + (conq * 1000000) + (tieneFruta * 10000000);
}

// ============================================
// SUPREMOS DINÁMICOS
// ============================================
let supremosCache = { data: [], timestamp: 0 };
const SUPREMOS_CACHE_TTL = 30000;

async function getSupremosActuales() {
    const ahora = Date.now();
    if (ahora - supremosCache.timestamp < SUPREMOS_CACHE_TTL) {
        return supremosCache.data;
    }

    try {
        const { data: dedicadosData, error: err1 } = await supabase
            .from('usuarios').select('username').gt('op_usos_hoy', 0);

        if (err1) { console.error('Error dedicados:', err1); return []; }

        const numDedicados = (dedicadosData || []).length;
        const plazasBase = numDedicados === 0 ? 0 : Math.floor(numDedicados / 21) + 1;

        const { data: maxData } = await supabase
            .from('usuarios').select('armadura')
            .order('armadura', { ascending: false }).limit(1);

        const maxArmadura = maxData?.[0]?.armadura || 0;
        const plazasExtra = maxArmadura >= 100 ? Math.floor((maxArmadura - 100) / 100) * 3 : 0;

        const { data: dueñoData } = await supabase
            .from('usuarios').select('supremos_min_historico')
            .eq('username', DUEÑO).maybeSingle();

        const minHistorico = dueñoData?.supremos_min_historico || 0;

        if (plazasBase > minHistorico) {
            await supabase.from('usuarios')
                .update({ supremos_min_historico: plazasBase })
                .eq('username', DUEÑO);
        }

        const plazasBaseEfectivas = Math.max(plazasBase, minHistorico);
        let totalPlazas = numDedicados === 0
            ? Math.max(plazasExtra, minHistorico)
            : Math.max(plazasBaseEfectivas, plazasExtra + 1);

        if (totalPlazas === 0) {
            supremosCache = { data: [], timestamp: ahora };
            return [];
        }

        const { data: topData, error: err3 } = await supabase
            .from('usuarios').select('username, armadura')
            .gte('armadura', 100)
            .order('armadura', { ascending: false })
            .limit(totalPlazas);

        if (err3) { console.error('Error top supremos:', err3); return []; }

        const result = (topData || []).map(u => u.username.toLowerCase());
        supremosCache = { data: result, timestamp: ahora };
        return result;
    } catch (err) {
        console.error('Error en getSupremosActuales:', err);
        return [];
    }
}

async function esSupremo(username) {
    const supremos = await getSupremosActuales();
    return supremos.includes(username.toLowerCase());
}

// ============================================
// SISTEMA DE COMBATE
// ============================================
function calcularPoderHakis(armadura, observacion, conquistador, esSupremoArmadura = false) {
    const factorArmadura = esSupremoArmadura ? 1.0 : (armadura <= 19 ? 0 : armadura <= 49 ? 0.2 : armadura <= 79 ? 0.5 : armadura <= 99 ? 0.8 : 1.0);
    const factorObservacion = observacion <= 19 ? 0 : observacion <= 49 ? 0.2 : observacion <= 79 ? 0.5 : observacion <= 99 ? 0.8 : 1.0;
    const factorConquistador = conquistador <= 49 ? 0 : conquistador <= 79 ? 0.1 : conquistador <= 94 ? 0.25 : conquistador <= 100 ? 0.5 : 1.0;

    return (armadura * factorArmadura * 2.5) + (observacion * factorObservacion * 1.8) + (conquistador * factorConquistador * 4.0);
}

const calcularPoderBase = (poderFruta, arm, obs, conq, esSupremo) =>
    poderFruta + calcularPoderHakis(arm, obs, conq, esSupremo);

function aplicarVariacion(poder) {
    return poder * (950 + Math.floor(Math.random() * 101)) / 1000;
}

function calcularCombate(poderUsuario, poderEnemigo) {
    const pfU = aplicarVariacion(poderUsuario);
    const pfE = aplicarVariacion(poderEnemigo);
    const diferencia = pfU - pfE;
    return {
        victoria: pfU > pfE,
        diferencia,
        porcentaje: (diferencia / pfE) * 100,
        poderFinalUsuario: pfU,
        poderFinalEnemigo: pfE
    };
}

function obtenerMensaje(victoria, porcentaje) {
    const cat = victoria ? 'victoria' : 'derrota';
    const absP = Math.abs(porcentaje);
    let rango = absP > 50 ? 'aplastante' : absP >= 20 ? 'clara' : absP >= 5 ? 'ajustada' : 'por_los_pelos';

    const mensajes = {
        victoria: {
            aplastante: ['¡VICTORIA ARROLLADORA! Tu poder es abrumador. El enemigo apenas puede mantenerse en pie antes de caer derrotado. La audiencia enmudece ante semejante despliegue de fuerza.', '¡HAS DEVASTADO A TU RIVAL! Cada golpe era una sentencia. El enemigo no ha tenido oportunidad ni de reaccionar.'],
            clara: ['¡VICTORIA CONTUNDENTE! Has dominado el combate de principio a fin. El enemigo ha luchado con honor, pero tu poder era muy superior.', '¡TRIUNFO SIN DISCUSIÓN! Te has impuesto con autoridad. El rival ha reconocido tu superioridad.'],
            ajustada: ['¡VICTORIA SUDADA! Has ganado, pero no ha sido fácil. Has tenido que emplearte a fondo para superar a tu rival.', '¡VICTORIA POR LOS JUSTOS! El combate ha sido igualado, pero tu determinación ha sido mayor.'],
            por_los_pelos: ['¡VICTORIA AGÓNICA! Literalmente has ganado por un pelo. El enemigo ha caído justo cuando se disponía a atacar. ¡Menudo respiro!', '¡VICTORIA MILAGROSA! Has ganado por centímetros. El destino ha estado de tu lado hoy.']
        },
        derrota: {
            aplastante: ['DERROTA ANIQUILADORA. El enemigo te ha superado con una facilidad pasmosa. Ni siquiera has podido reaccionar a sus movimientos.', 'HAS SIDO BARRIDO. Tu oponente era de otro nivel. Vuelve a entrenar y busca la revancha.'],
            clara: ['DERROTA CLARA. Has luchado con valor, pero el enemigo ha sido claramente superior. La diferencia de poder era evidente.', 'DERROTA SIN PALIATIVOS. Has dado todo, pero el rival ha sido demasiado fuerte hoy.'],
            ajustada: ['DERROTA AJUSTADA. Has estado a punto de ganar. El combate ha sido igualado, pero en el momento clave el enemigo ha sido más listo.', 'DERROTA POR POCO. Has peleado bien, pero te ha faltado un último esfuerzo.'],
            por_los_pelos: ['DERROTA POR LOS PELOS. Has perdido por un suspiro. El enemigo ha caído justo después de su ataque, pero ha sido él quien se ha levantado primero.', 'DERROTA INEXTREMIS. Has estado a punto de ganar. La diferencia ha sido mínima.']
        }
    };
    const pool = mensajes[cat][rango] || mensajes[cat]['ajustada'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================
// ADMIN
// ============================================
const ADMIN_STATS = {
    sumar1: { campo: 'armadura', nombre: 'armadura', signo: 1 },
    sumar2: { campo: 'observacion', nombre: 'observación', signo: 1 },
    sumar3: { campo: 'conquistador', nombre: 'conquistador', signo: 1 },
    restar1: { campo: 'armadura', nombre: 'armadura', signo: -1 },
    restar2: { campo: 'observacion', nombre: 'observación', signo: -1 },
    restar3: { campo: 'conquistador', nombre: 'conquistador', signo: -1 }
};

const esDueño = (username) => username.toLowerCase() === DUEÑO;

// ============================================
// CLIENTE TWITCH (IRC)
// ============================================
const client = new tmi.Client({
    options: { debug: true },
    identity: { username: config.botName, password: config.oauth },
    channels: [config.channelName, 'op_d_bot']
});

client.connect()
    .then(() => console.log(`Bot conectado como ${config.botName} en #${config.channelName} y #op_d_bot`))
    .catch(err => console.error('Error al conectar:', err));

// ============================================
// EVENTSUB WEBSOCKET
// ============================================
let websocketSessionId = null;

function startEventSubWebSocket() {
    const ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

    ws.on('open', () => console.log('🔌 Conectado a EventSub WebSocket'));

    ws.on('message', async (data) => {
        const message = JSON.parse(data.toString());
        const messageType = message.metadata.message_type;

        if (messageType === 'session_welcome') {
            websocketSessionId = message.payload.session.id;
            console.log(`🔑 Sesión EventSub: ${websocketSessionId}`);
            await subscribeToWhispers();
        } else if (messageType === 'notification') {
            if (message.payload.subscription.type === 'user.whisper.message') {
                await handleWhisper(message.payload.event);
            }
        } else if (messageType === 'session_reconnect') {
            console.log('🔄 Reconectando EventSub...');
            startEventSubWebSocket();
        }
    });

    ws.on('error', (err) => console.error('❌ Error en EventSub WebSocket:', err));

    ws.on('close', () => {
        console.log('🔌 EventSub WebSocket cerrado. Reconectando en 5 segundos...');
        setTimeout(startEventSubWebSocket, 5000);
    });
}

async function subscribeToWhispers() {
    const url = `${TWITCH_API_URL}/eventsub/subscriptions`;
    const body = {
        type: 'user.whisper.message',
        version: '1',
        condition: { user_id: config.botUserId },
        transport: { method: 'websocket', session_id: websocketSessionId }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Client-ID': config.clientId,
                'Authorization': `Bearer ${config.oauth.replace('oauth:', '')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (response.status === 202) console.log('✅ Suscripción a susurros creada exitosamente.');
        else console.error('❌ Error al suscribirse:', await response.text());
    } catch (err) {
        console.error('❌ Error de red al suscribirse:', err);
    }
}

async function sendWhisper(toUserId, message) {
    const url = `${TWITCH_API_URL}/whispers?from_user_id=${config.botUserId}&to_user_id=${toUserId}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Client-ID': config.clientId,
                'Authorization': `Bearer ${config.oauth.replace('oauth:', '')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message })
        });
        if (response.status === 204) console.log(`✅ Susurro enviado a ${toUserId}`);
        else console.error(`❌ Error al enviar susurro: ${response.status}`, await response.text());
    } catch (err) {
        console.error('❌ Error de red al enviar susurro:', err);
    }
}

setTimeout(startEventSubWebSocket, 3000);

// ============================================
// HANDLER DE SUSURROS (SOLO RESPONDE POR SUSURRO)
// ============================================
async function handleWhisper(event) {
    const fromUserId = event.from_user_id;
    const fromUserLogin = event.from_user_login;
    const messageText = event.whisper.text.trim();
    const args = messageText.split(' ');
    const command = args[0].toLowerCase();
    const username = fromUserLogin.toLowerCase();

    console.log(`📩 [SUSURRO] de ${fromUserLogin}: ${messageText}`);

    // ========== !testwhisper ==========
    if (command === '!testwhisper') {
        await sendWhisper(fromUserId, `¡Hola ${fromUserLogin}! Los susurros funcionan correctamente. 🎉`);
        return;
    }

    // ========== !ayudabotsito ==========
    if (command === '!ayudabotsito') {
        if (args[1] === 'chat') {
            const ayuda = `💬 COMANDOS DE CHAT

🎮 !op → Entrena Haki de Armadura (3/día)
🍎 !fruta → Busca una fruta del diablo
😋 !comer → Consume la fruta pendiente
❌ !rechazar → Rechaza la fruta pendiente
📊 !infoop → Tu info (corta, actualiza recompensa)
⏳ !frutapendiente → Tu evento de fruta pendiente
✅ !si / ❌ !no → Decide en evento de fruta
⚔️ !pelear / 🏃 !huir → Combate en evento de fruta
❓ !ayuda → Este mensaje`;
            await sendWhisper(fromUserId, ayuda);
        } else if (args[1] === 'susurro') {
            const ayuda = `📩 COMANDOS DE SUSURRO

🗺️ !explorar → Explora el mundo (1/día)
➡️ !continuar / ⬅️ !retroceder → Decide en exploración
⚔️ !combatir / 🏃 !retirarse → Combate en exploración
⏳ !exploracionpendiente → Tu evento de exploración
📊 !infoop → Tu info completa (con puntos)
👤 !infoop @usuario → Info corta de otro usuario
❓ !ayudabotsito → Esta ayuda`;
            await sendWhisper(fromUserId, ayuda);
        } else {
            const ayuda = `📖 AYUDA - op_d_bot

¿Qué querés ver?

💬 !ayudabotsito chat → Comandos de chat
📩 !ayudabotsito susurro → Comandos de susurro`;
            await sendWhisper(fromUserId, ayuda);
        }
        return;
    }

    // ========== !infoop (propio detallado) ==========
    if (command === '!infoop' && !args[1]) {
        const user = await getUsuario(username);
        const esSupremoUser = await esSupremo(username);

        let frutaTexto = '🍎 Ninguna';
        if (user?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            const emojiFruta = frutaData?.emoji || '';
            frutaTexto = `🍎 ${user.fruta} ${emojiFruta}`.trim();
        }

        const rangoArm = getRangoArmadura(user?.armadura || 0, esSupremoUser);
        const rangoObs = getRangoArmadura(user?.observacion || 0);
        const rangoConq = getRangoArmadura(user?.conquistador || 0);

        const mensaje = `📊 Tus estadísticas:
${frutaTexto}
🛡️ Armadura: ${rangoArm.nombre} (${user?.armadura || 0} pts) ${rangoArm.emoji}
👁️ Observación: ${rangoObs.nombre} (${user?.observacion || 0} pts)
⚜️ Conquistador: ${rangoConq.nombre} (${user?.conquistador || 0} pts)
🏴‍☠️💰 Recompensa: $${(user?.recompensa_publica || 0).toLocaleString('es-AR')}`;

        await sendWhisper(fromUserId, mensaje);
        return;
    }

    // ========== !infoop @usuario (corto) ==========
    if (command === '!infoop' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target);
        const esSupremoUser = await esSupremo(target);

        let frutaTexto = '🍎 Ninguna';
        if (targetUser?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', targetUser.fruta).single();
            const emojiFruta = frutaData?.emoji || '';
            frutaTexto = `🍎 ${targetUser.fruta} ${emojiFruta}`.trim();
        }

        const emojiArm = getEmojiRango(targetUser?.armadura || 0, 'armadura', esSupremoUser);
        const emojiObs = getEmojiRango(targetUser?.observacion || 0, 'observacion');
        const emojiConq = getEmojiRango(targetUser?.conquistador || 0, 'conquistador');

        await sendWhisper(fromUserId, `@${target} | ${frutaTexto} | 🛡️:${emojiArm} | 👁️:${emojiObs} | ⚜️:${emojiConq} | 🏴‍☠️💰 $${(targetUser?.recompensa_publica || 0).toLocaleString('es-AR')}`);
        return;
    }

    // ========== !frutapendiente ==========
    if (command === '!frutapendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente') {
            await sendWhisper(fromUserId, `No tienes ningún evento de fruta pendiente.`);
            return;
        }

        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            await sendWhisper(fromUserId, `La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`);
            return;
        }

        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) {
            await sendWhisper(fromUserId, `Error al obtener detalles del evento.`);
            return;
        }

        if (user.evento_fruta_fase === 'avistamiento') {
            await sendWhisper(fromUserId, fruta.fase1);
        } else {
            const emoji = fruta.emoji || '';
            const atq = fruta.ataque || 0;
            const def = fruta.defensa || 0;
            const util = fruta.utilidad || 0;
            const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
            await sendWhisper(fromUserId, `${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${emoji} ⚔️ ${atq} | 🛡️ ${def} | 🧠 Utilidad: ${util} — ¿Qué haces? !pelear o !huir`);
        }
        return;
    }

    // ========== !exploracionpendiente ==========
    if (command === '!exploracionpendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente') {
            await sendWhisper(fromUserId, `No tienes ningún evento de exploración pendiente.`);
            return;
        }

        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        if (!npc) {
            await sendWhisper(fromUserId, `Error al obtener detalles del evento.`);
            return;
        }

        if (user.evento_explorar_fase === 'avistamiento') {
            await sendWhisper(fromUserId, npc.fase1);
        } else {
            const calaveras = getCalaveras(user.evento_explorar_nivel || 1);
            await sendWhisper(fromUserId, `${npc.fase2} ${calaveras} — ¿Qué haces? !combatir o !retirarse`);
        }
        return;
    }
}

// ============================================
// COMANDOS DE CHAT PÚBLICO
// ============================================
client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();
    const username = tags.username.toLowerCase();

    // DEBUG: Ver qué mensajes llegan por IRC
    console.log(`💬 [CHAT #${channel}] ${username}: ${message}`);

    // ========== !ayuda ==========
    if (command === '!ayuda') {
        client.say(channel, `@${tags.username} 📩 Mandame un susurro con !ayudabotsito para ver todos los comandos.`);
        return;
    }

    // ========== !infoop (chat) ==========
    if (command === '!infoop') {
        if (args[1]) {
            client.say(channel, `@${tags.username} Para ver la info de otro usuario, mandame un susurro con: !infoop @usuario 📩`);
            return;
        }

        const user = await getUsuario(username);
        const esSupremoUser = await esSupremo(username);

        const nuevaRecompensa = calcularRecompensa(user);
        await updateUsuario(username, { recompensa_publica: nuevaRecompensa });

        let frutaTexto = '🍎 Ninguna';
        if (user?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            const emojiFruta = frutaData?.emoji || '';
            frutaTexto = `🍎 ${user.fruta} ${emojiFruta}`.trim();
        }

        const emojiArm = getEmojiRango(user?.armadura || 0, 'armadura', esSupremoUser);
        const emojiObs = getEmojiRango(user?.observacion || 0, 'observacion');
        const emojiConq = getEmojiRango(user?.conquistador || 0, 'conquistador');

        client.say(channel, `@${username} | ${frutaTexto} | 🛡️:${emojiArm} | 👁️:${emojiObs} | ⚜️:${emojiConq} | 🏴‍☠️💰 $${nuevaRecompensa.toLocaleString('es-AR')}`);
        return;
    }

    // ========== !op ==========
    if (command === '!op') {
        const user = await getUsuario(username);
        const ahora = Date.now();
        const ultimoTs = user.ultimo_op_timestamp ? new Date(user.ultimo_op_timestamp).getTime() : 0;
        const tiempoRestante = (10 * 60 * 1000) - (ahora - ultimoTs);

        if (tiempoRestante > 0) {
            const min = Math.floor(tiempoRestante / 60000);
            const seg = Math.floor((tiempoRestante % 60000) / 1000);
            client.say(channel, `⏳ Todavía no podés entrenar. Te faltan ${min}m ${seg}s para volver a usar !op.`);
            return;
        }

        const hoy = getFechaHoy();
        const ultimoDia = user.ultimo_op_fecha || null;

        if (ultimoDia !== hoy) {
            const usosAyer = user.op_usos_hoy || 0;
            const usosFaltantes = 3 - usosAyer;

            if (usosFaltantes > 0 && ultimoDia !== null) {
                let arm = user.armadura || 0;
                let delta = 0;

                if (usosAyer === 0 && arm < 20) {
                    delta = -1;
                    arm = Math.max(arm - 1, 0);
                } else {
                    for (let i = 0; i < usosFaltantes; i++) {
                        const rango = getRangoArmadura(arm);
                        const int = getIntervaloTirada(rango.nombre);
                        const peor = Math.min(int.min, int.max);
                        delta += peor;
                        arm = Math.max(arm + peor, 0);
                    }
                }

                if (delta !== 0) {
                    client.say(channel, `💤 Descuidaste tu entrenamiento. Perdiste ${Math.abs(delta)} de Haki de Armadura. ${getRangoArmadura(arm).emoji}`);
                }

                await updateUsuario(username, { armadura: arm, op_usos_hoy: 0, ultimo_op_fecha: hoy, racha_ops: 0 });
            } else {
                await updateUsuario(username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
            }
        }

        const userAct = await getUsuario(username);

        if ((userAct.op_usos_hoy || 0) >= 3) {
            client.say(channel, `Tu cuerpo llegó al límite por hoy. Descansá y mañana seguís.`);
            return;
        }

        const armActual = userAct.armadura || 0;
        const eraSupremo = await esSupremo(username);
        const rangoActual = getRangoArmadura(armActual, eraSupremo);
        const intervalo = getIntervaloTirada(rangoActual.nombre);
        const delta = tiradaAleatoria(intervalo.min, intervalo.max);
        const nuevaArm = Math.max(armActual + delta, 0);
        const nuevosUsos = (userAct.op_usos_hoy || 0) + 1;

        const updateData = {
            armadura: nuevaArm,
            op_usos_hoy: nuevosUsos,
            ultimo_op_fecha: hoy,
            ultimo_op_timestamp: new Date().toISOString()
        };

        const mensajesExtra = [];
        if (nuevosUsos === 3) {
            const bonusDiario = getBonusDiario(rangoActual.nombre);
            mensajesExtra.push(`🔥 Completaste tu entrenamiento diario: +${bonusDiario} de Haki de Armadura.`);

            const ultimoDiaRacha = userAct.ultimo_dia_racha || null;
            let rachaActual = userAct.racha_ops || 0;
            rachaActual = (ultimoDiaRacha === getFechaAyer()) ? rachaActual + 1 : 1;

            const bonusRacha = getBonusRacha(rachaActual);
            mensajesExtra.push(`🔥 Racha de ${rachaActual} días: +${bonusRacha} extra.`);

            updateData.armadura = nuevaArm + bonusDiario + bonusRacha;
            updateData.racha_ops = rachaActual;
            updateData.ultimo_dia_racha = hoy;
        }

        await updateUsuario(username, updateData);

        const ahoraSupremo = await esSupremo(username);
        const rangoFinal = getRangoArmadura(updateData.armadura, ahoraSupremo);
        const texto = getTextoResultado(rangoFinal.nombre, delta);

        let respuesta = `@${tags.username} ${texto} ${delta > 0 ? '+' : ''}${delta} de Haki de Armadura ${rangoFinal.emoji}`;

        const rangoAnterior = eraSupremo ? 'Supremo' : getRangoArmadura(armActual).nombre;
        if (rangoAnterior !== rangoFinal.nombre) {
            const msg = getMensajeNuevoRango(rangoFinal.nombre, tags.username);
            if (msg) respuesta += ` | ${msg}`;
        }

        if (mensajesExtra.length > 0) respuesta += ` | ${mensajesExtra.join(' | ')}`;

        client.say(channel, respuesta);
        return;
    }

    // ========== !fruta ==========
    if (command === '!fruta') {
        try {
            const user = await getUsuario(username);

            if (user?.fruta) {
                client.say(channel, `@${tags.username} Ya tienes una fruta (${user.fruta}).`);
                return;
            }

            if (user?.evento_fruta_estado === 'pendiente') {
                client.say(channel, `@${tags.username} Ya tienes un evento de fruta pendiente. Usa !frutapendiente para ver la decisión que debes tomar.`);
                return;
            }

            const ahora = Date.now();
            const ultimoUso = cooldowns[`fruta_${username}`] || 0;
            const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
            if (tiempoRestante > 0) {
                const seg = Math.ceil(tiempoRestante / 1000);
                client.say(channel, `@${tags.username} Debes esperar ${seg} segundos para usar !fruta nuevamente.`);
                return;
            }

            cooldowns[`fruta_${username}`] = Date.now();

            if (Math.random() * 100 > PROB_FRUTA) {
                client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
                return;
            }

            const { data: usuariosConFruta } = await supabase
                .from('usuarios').select('fruta').not('fruta', 'is', null);
            const frutasOcupadas = (usuariosConFruta || []).map(u => u.fruta).filter(Boolean);

            let query = supabase.from('frutas').select('*');
            if (frutasOcupadas.length > 0) {
                query = query.not('nombre', 'in', `(${frutasOcupadas.map(f => `'${f}'`).join(',')})`);
            }

            const { data: frutasDisponibles, error: errFrutas } = await query;

            if (errFrutas || !frutasDisponibles?.length) {
                client.say(channel, `@${tags.username} No hay frutas disponibles en este momento. ¡Vuelve más tarde!`);
                return;
            }

            const totalProb = frutasDisponibles.reduce((s, f) => s + (Number(f.probabilidad) || 0), 0);

            let selectedFruit = null;
            if (totalProb <= 0) {
                selectedFruit = frutasDisponibles[Math.floor(Math.random() * frutasDisponibles.length)];
            } else {
                let randomPick = Math.random() * totalProb;
                for (const f of frutasDisponibles) {
                    randomPick -= (Number(f.probabilidad) || 0);
                    if (randomPick <= 0) { selectedFruit = f; break; }
                }
            }

            if (!selectedFruit) selectedFruit = frutasDisponibles[0];

            if (selectedFruit.evento) {
                await updateUsuario(username, {
                    evento_fruta_tipo: 'fruta', evento_fruta_fase: 'avistamiento',
                    evento_fruta_nombre: selectedFruit.nombre, evento_fruta_nivel: selectedFruit.nivel || 1,
                    evento_fruta_estado: 'pendiente', evento_fruta_comandos: 'si_no',
                    evento_fruta_comida_por_otro: false
                });
                client.say(channel, `@${tags.username} ${selectedFruit.fase1}`);
            } else {
                await updateUsuario(username, { fruta_pendiente: selectedFruit.nombre });
                const emoji = selectedFruit.emoji || '';
                const atq = selectedFruit.ataque || 0;
                const def = selectedFruit.defensa || 0;
                const util = selectedFruit.utilidad || 0;
                const desc = selectedFruit.descripcion || '';
                client.say(channel, `@${tags.username} ¡Felicidades! Has encontrado la ${selectedFruit.nombre} ${emoji} — ${desc} ⚔️ ${atq} | 🛡️ ${def} | 🧠 Utilidad: ${util} — ¿Qué decisión tomas? !comer o !rechazar`);
            }
        } catch (err) {
            console.error('❌ Error en !fruta:', err);
            client.say(channel, `@${tags.username} Hubo un error. Intenta de nuevo.`);
        }
        return;
    }

    // ========== !frutapendiente (chat) ==========
    if (command === '!frutapendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente') {
            client.say(channel, `@${tags.username} No tienes ningún evento de fruta pendiente.`);
            return;
        }

        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`);
            return;
        }

        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) {
            client.say(channel, `@${tags.username} Error al obtener detalles del evento.`);
            return;
        }

        if (user.evento_fruta_fase === 'avistamiento') {
            client.say(channel, `@${tags.username} ${fruta.fase1}`);
        } else {
            const emoji = fruta.emoji || '';
            const atq = fruta.ataque || 0;
            const def = fruta.defensa || 0;
            const util = fruta.utilidad || 0;
            const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
            client.say(channel, `@${tags.username} ${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${emoji} ⚔️ ${atq} | 🛡️ ${def} | 🧠 Utilidad: ${util} — ¿Qué haces? !pelear o !huir`);
        }
        return;
    }

    // ========== !si ==========
    if (command === '!si') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`);
            return;
        }

        await updateUsuario(username, { evento_fruta_fase: 'encuentro', evento_fruta_comandos: 'pelear_huir' });
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();

        const emoji = fruta.emoji || '';
        const atq = fruta.ataque || 0;
        const def = fruta.defensa || 0;
        const util = fruta.utilidad || 0;
        const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
        client.say(channel, `@${tags.username} ${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${emoji} ⚔️ ${atq} | 🛡️ ${def} | 🧠 Utilidad: ${util} — ¿Qué haces? !pelear o !huir`);
        return;
    }

    // ========== !no ==========
    if (command === '!no') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, `@${tags.username} Decides retirarte. El evento ha terminado.`);
        return;
    }

    // ========== !pelear ==========
    if (command === '!pelear') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`);
            return;
        }

        const { data: frutaData } = await supabase.from('frutas')
            .select('poder_fruta, sombra, emoji').eq('nombre', user.evento_fruta_nombre).single();

        const poderFrutaUsuario = frutaData?.poder_fruta || 0;
        const nombreSombra = frutaData?.sombra || null;
        const emojiFruta = frutaData?.emoji || '';
        const esSupremoUser = await esSupremo(username);

        const poderUsuario = calcularPoderBase(
            poderFrutaUsuario, user.armadura || 0, user.observacion || 0,
            user.conquistador || 0, esSupremoUser
        );

        let poderEnemigoBase = 80;
        if (nombreSombra) {
            const { data: npc } = await supabase.from('npcs')
                .select('pcf_final, pcf_calculado, nivel').eq('nombre', nombreSombra).maybeSingle();
            poderEnemigoBase = npc?.pcf_final || npc?.pcf_calculado || 80;
        } else {
            poderEnemigoBase = 20 + (user.evento_fruta_nivel || 4) * 15;
        }

        const resultado = calcularCombate(poderUsuario, poderEnemigoBase);
        const nivel = user.evento_fruta_nivel || 4;
        const baseConq = nivel * 5;
        const baseBerries = nivel * 1000000;
        const recConq = resultado.victoria ? baseConq : -Math.floor(baseConq / 2);
        const recBerries = resultado.victoria ? baseBerries : -Math.floor(baseBerries / 4);
        const mensaje = obtenerMensaje(resultado.victoria, resultado.porcentaje);

        if (resultado.victoria) {
            const { data: usuarioConFruta } = await supabase
                .from('usuarios').select('username')
                .eq('fruta', user.evento_fruta_nombre).maybeSingle();

            if (usuarioConFruta) {
                await updateUsuario(username, {
                    conquistador: (user.conquistador || 0) + recConq,
                    recompensa_publica: (user.recompensa_publica || 0) + recBerries,
                    evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                    evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                    evento_fruta_comida_por_otro: false
                });
                client.say(channel, `@${tags.username} ${mensaje} Pero la ${user.evento_fruta_nombre} ya fue consumida por otro usuario. No puedes obtenerla.`);
                return;
            }

            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConq,
                recompensa_publica: (user.recompensa_publica || 0) + recBerries,
                fruta: user.evento_fruta_nombre,
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });

            client.say(channel, `@${tags.username} ${mensaje} 🍎 ¡Has obtenido la ${user.evento_fruta_nombre} ${emojiFruta}!`);

            const { data: afectados } = await supabase
                .from('usuarios').select('username')
                .eq('evento_fruta_nombre', user.evento_fruta_nombre)
                .eq('evento_fruta_estado', 'pendiente')
                .neq('username', username);

            if (afectados && afectados.length > 0) {
                for (const afectado of afectados) {
                    await updateUsuario(afectado.username, {
                        evento_fruta_comida_por_otro: true
                    });
                }
                console.log(`📩 Notificados ${afectados.length} usuarios sobre consumo de ${user.evento_fruta_nombre}`);
            }
        } else {
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConq,
                recompensa_publica: (user.recompensa_publica || 0) + recBerries,
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} ${mensaje}`);
        }
        return;
    }

    // ========== !huir ==========
    if (command === '!huir') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, `@${tags.username} Has decidido huir. No has obtenido la fruta.`);
        return;
    }

    // ========== !comer ==========
    if (command === '!comer') {
        const user = await getUsuario(username);
        if (user?.fruta_pendiente) {
            const { data: frutaData } = await supabase.from('frutas')
                .select('descripcion, emoji').eq('nombre', user.fruta_pendiente).single();
            const descripcion = frutaData?.descripcion || 'humano de algo misterioso';
            const emoji = frutaData?.emoji || '';
            await updateUsuario(username, { fruta: user.fruta_pendiente, fruta_pendiente: null });
            client.say(channel, `@${tags.username} Has consumido la ${user.fruta_pendiente} ${emoji}. Ahora eres un ${descripcion}.`);
        } else {
            client.say(channel, `@${tags.username} FELICIDADES TE COMISTE... ESTA 🫱`);
        }
        return;
    }

    // ========== !rechazar ==========
    if (command === '!rechazar') {
        const user = await getUsuario(username);
        if (user?.fruta_pendiente) {
            await updateUsuario(username, { fruta_pendiente: null });
            client.say(channel, `@${tags.username} Has rechazado la ${user.fruta_pendiente}. ¡Quizás la próxima sea mejor!`);
        } else if (user?.fruta) {
            client.say(channel, `@${tags.username} Ya has consumido tu fruta (${user.fruta}). No puedes rechazarla.`);
        } else {
            client.say(channel, `@${tags.username} Como te rechazaron toda tu vida, ¿no?`);
        }
        return;
    }

    // ============================================
    // COMANDOS DE ADMIN
    // ============================================
    if (!esDueño(username)) return;

    const cmdName = command.substring(1);
    if (ADMIN_STATS[cmdName]) {
        const { campo, nombre, signo } = ADMIN_STATS[cmdName];
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: ${command} @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);

        const user = await getUsuario(target);
        const actual = user[campo] || 0;
        const nuevo = signo > 0 ? actual + cantidad : Math.max(actual - cantidad, 0);
        await updateUsuario(target, { [campo]: nuevo });
        const verbo = signo > 0 ? 'sumado' : 'restado';
        client.say(channel, `@${tags.username} Has ${verbo} ${cantidad} de ${nombre} a @${target}. Ahora tiene ${nuevo}.`);
        return;
    }

    if (command === '!quitarfruta') {
        if (args.length < 2) return client.say(channel, `@${tags.username} Uso: !quitarfruta @usuario`);
        const target = args[1].replace('@', '').toLowerCase();
        await updateUsuario(target, { fruta: null, fruta_pendiente: null });
        client.say(channel, `@${tags.username} Has quitado la fruta a @${target}.`);
        return;
    }

    if (command === '!setpcf') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !setpcf nombreNPC poder`);
        const npcNombre = args[1].toLowerCase();
        const nuevoPoder = parseInt(args[2]);
        if (isNaN(nuevoPoder) || nuevoPoder < 0) return client.say(channel, `@${tags.username} El poder debe ser un número positivo.`);

        const { data: npcExistente, error: searchError } = await supabase
            .from('npcs').select('*').eq('nombre', npcNombre).maybeSingle();

        if (searchError) return client.say(channel, `@${tags.username} Error al buscar el enemigo.`);

        if (npcExistente) {
            const { error } = await supabase.from('npcs').update({ pcf_final: nuevoPoder }).eq('nombre', npcNombre);
            if (error) return client.say(channel, `@${tags.username} Error al actualizar el poder.`);
        } else {
            const { error } = await supabase.from('npcs').insert([{ nombre: npcNombre, pcf_final: nuevoPoder, nivel: 4 }]);
            if (error) return client.say(channel, `@${tags.username} Error al crear el enemigo.`);
        }

        client.say(channel, `@${tags.username} Has cambiado el PCF de ${npcNombre} a ${nuevoPoder}.`);
        return;
    }
});

console.log('Bot escuchando...');