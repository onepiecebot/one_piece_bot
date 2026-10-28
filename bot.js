require('dotenv').config();
const tmi = require('tmi.js');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');
const db = require('./database.js');
const {
    getUsuario, updateUsuario, supabase,
    getTextoDuelo, getTextoExplorar, getHistorialH2H,
    contarDuelosHoy, contarDuelosHoyEntre, fueRechazadoHoy,
    crearDuelo, limpiarEventoDuelo,
    completoExplorarHoy, getFechaHoy, getFechaOffset, getFechaNpc,
    usuarioExiste,
    getCanal, getCanales, updateCanal,
    getLurkV2, updateLurkV2,
    getLurkReg, updateLurkReg,
    recalcularObservacionNueva, agregarPuntosObservacionNueva,
    avanzarVigencia
} = db;

// ============================================
// CONSTANTES
// ============================================
const COOLDOWN_FRUTA = 10 * 60 * 1000; // 10 min
const FRUTA_LIMITE_DIARIO = 5;
const TOTAL_PUERTAS_JUEGO = 10000;
const FACTOR_RECOMPENSA = 3614500; // berries por punto de aporte de haki
const TOPE_DELTA_MULT = 1.8; // tope delta = 1.8 × max base histórica
const EXP_PROB = 4.0; // exponente de la fórmula de probabilidad (duelos, explorar, coliseo, fruta)
const DUEÑO = 'fan_d_larana';
const TWITCH_API_URL = 'https://api.twitch.tv/helix';
const GITHUB_REPO = 'onepiecebot/one_piece_bot';

const DUELO_COOLDOWN_MS = 5 * 60 * 1000;
const DUELO_LIMITE_DIARIO = 10;
const DUELO_LIMITE_PAREJA = 3;
const DUELO_TIMEOUT_MS = 2 * 60 * 1000;

// Canales donde se cuenta lurk. fan_d_larana y op_d_bot NO tienen lurk
// porque no son canales de streamer. Se agregan acá a medida que suman.
const CANALES_CON_LURK = ['lenno_ap', 'pepeecr'];
const LURK_MICRO_COOLDOWN_MS = 2 * 60 * 1000;
const LURK_LIVE_MINIMO_2H = 120;

const NPC_VENTANA_MINUTOS = 10;

// Coliseo
const COLISEO_VENTANA_MINUTOS = 3;
const COLISEO_CONQ_MINIMO = 5;
const COLISEO_PROB_MIN = 0.15; // si el más débil tiene menos de 15%, no pelean (nadie supera 85%)
const COLISEO_EXP_BR = 1.2; // exponente para battle royale
const COLISEO_TOPE_PARTICIPANTES = 12;
const COLISEO_BERRIES_POR_CONQ = 10000000; // $10M por punto de Conq arriesgado

// Frutas meme (aparecen al fallar el sorteo, 40% de las veces)
const MEMES_FRUTAS = [
    { nombre: 'mandarina', emoji: '🍊',
      comer: 'Mandarina consumida. Refrescante, la verdad.',
      rechazar: 'Mandarina rechazada. ¿Y ahora quién te da vitamina C?' },
    { nombre: 'banana', emoji: '🍌',
      comer: 'Te comiste una banana. Potasio para los calambres, dicen.',
      rechazar: 'Rechazaste la banana. Calambres te esperan.' },
    { nombre: 'manzana', emoji: '🍎',
      comer: 'Manzana consumida. Clásica y efectiva.',
      rechazar: 'La manzana te miró y le dijiste no. Frío.' },
    { nombre: 'pera', emoji: '🍐',
      comer: 'Te comiste una pera. Fibra para el cuerpo.',
      rechazar: 'Pera rechazada. Fibra perdida.' },
    { nombre: 'uva', emoji: '🍇',
      comer: 'Uva consumida. Poca cosa pero rica.',
      rechazar: 'Uva rechazada. Antioxidantes perdidos.' },
    { nombre: 'ananá', emoji: '🍍',
      comer: 'Ananá al buche. Un lujo tropical.',
      rechazar: 'Rechazaste el ananá. Dulce, pero no era el momento.' },
    { nombre: 'tomate', emoji: '🍅',
      comer: '¿Quién se come un tomate como si fuese una fruta común? ... Me das miedo.',
      rechazar: 'Lo dejaste. Menos mal.' }
];

// NPCs que NO salen como avistamiento (son de relleno)
const NPCS_EXCLUIDOS_AVISTAMIENTO = [
    'Cazarrecompensas Aprendiz', 'Marine Raso', 'Pirata Novato',
    'Bandido De Caminos', 'Ladrón De Puerto',
    'Borracho De Taberna', 'Pordiosero Del Puerto', 'Granjero Enfurecido',
    'Contrabandista Torpe', 'Bandido Herido'
];

const esDueño = (username) => username.toLowerCase() === DUEÑO;

const cooldowns = {};
const cooldownsLurk = {};
const cooldownsCanaleson = {};
const cooldownsOnOff = {};

// Estado de mantenimiento (se lee de bot_config al arrancar, se actualiza al !deploy/!deploylisto)
let mantenimientoActivo = false;
let predeployActivo = false;

async function cargarEstadoMantenimiento() {
    try {
        const { data } = await supabase.from('bot_config').select('valor').eq('clave', 'mantenimiento').maybeSingle();
        mantenimientoActivo = (data && data.valor === 'true');
        console.log('🔧 Estado mantenimiento: ' + (mantenimientoActivo ? 'ACTIVO' : 'inactivo'));
        const { data: pd } = await supabase.from('bot_config').select('valor').eq('clave', 'predeploy').maybeSingle();
        predeployActivo = (pd && pd.valor === 'true');
        console.log('🔧 Estado predeploy: ' + (predeployActivo ? 'ACTIVO' : 'inactivo'));
    } catch (e) { console.error('Error cargando mantenimiento:', e); }
}

async function setPredeploy(valor) {
    predeployActivo = valor;
    await supabase.from('bot_config').upsert({ clave: 'predeploy', valor: valor ? 'true' : 'false' });
    if (valor) {
        await supabase.from('bot_config').upsert({ clave: 'predeploy_avisado', valor: 'false' });
    }
}

async function contarVentanasColiseo() {
    const { count } = await supabase.from('coliseo').select('*', { count: 'exact', head: true }).eq('estado', 'ventana');
    return count || 0;
}

async function setMantenimiento(valor) {
    mantenimientoActivo = valor;
    await supabase.from('bot_config').upsert({ clave: 'mantenimiento', valor: valor ? 'true' : 'false' });
}

// Cache de PCF/recompensa por usuario (10s TTL). Evita repetir queries dentro del mismo comando.
const pcfCache = {};      // { username: { data, timestamp } }
const recompCache = {};   // { username: { data, timestamp } }
const PCF_RECOMP_CACHE_TTL = 10 * 1000;

// Cuando un comando de susurro se tira en el chat de op_d_bot,
// guardamos acá el contexto para redirigir las respuestas a chat con @username.
const contextoOpDBot = new AsyncLocalStorage();

// Comandos que usan el usuario (crean en DB si no existe, guardan twitch_user_id).
const COMANDOS_CON_USUARIO = [
    '!op', '!fruta', '!comer', '!rechazar', '!frutapendiente',
    '!retar', '!aceptarduelo', '!rechazarduelo', '!historial',
    '!infoop', '!si', '!no', '!pelear', '!huir',
    '!sumar1', '!sumar2', '!sumar3', '!sumar4', '!restar1', '!restar2', '!restar3', '!restar4',
    '!quitarfruta',
    '!explorar', '!facil', '!medio', '!dificil',
    '!continuar', '!retroceder', '!combatir', '!retirarse',
    '!exploracionpendiente', '!duelopendiente',
    '!observacion', '!personaje',
    '!coliseo',
    '!susurrame'
];

// Comandos que funcionan también por chat en op_d_bot (redirigidos al handler de susurro).
const COMANDOS_SUSURRO_EN_OP_D_BOT = [
    '!explorar',
    '!facil', '!medio', '!dificil',
    '!continuar', '!retroceder',
    '!combatir', '!retirarse',
    '!exploracionpendiente',
    '!duelopendiente',
    '!actualizacion',
    '!observacion',
    '!canaleson',
    '!personaje',
    '!ayuda', '!ayudachat', '!ayudasusurro', '!ayudaop',
    '!testwhisper',
    '!infoop'
];

// Comandos que el bot reconoce. Solo estos se loguean en el chat.
const COMANDOS_DEL_BOT = new Set([
    ...COMANDOS_CON_USUARIO,
    ...COMANDOS_SUSURRO_EN_OP_D_BOT,
    '!onop', '!offop',
    '!setepisodio',
    '!deploylisto',
    '!perder',
    '!deploy', '!dep',
    '!deplis'
]);

// ============================================
// HELPERS GENERALES
// ============================================
function displayStat(valor) {
    if (valor === 11) return '10+';
    return String(valor);
}
function formatBerries(n) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
}

function esModOCaster(tags) {
    if (tags.badges && tags.badges.broadcaster === '1') return true;
    if (tags.mod === true) return true;
    return false;
}

function normalizarComando(cmd) {
    return cmd.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ============================================
// SCHEDULER DE PENALIZACIONES (3:45 AR)
// ============================================
async function schedulerPenalizacionesDiarias() {
    try {
        // Solo corre si ya pasó las 3:45 AR y no corrió hoy
        const ahora = new Date();
        const utcMs = ahora.getTime();
        const arMs = utcMs - (3 * 60 * 60 * 1000);
        const argNow = new Date(arMs);
        const hora = argNow.getUTCHours();
        const min = argNow.getUTCMinutes();
        if (hora < 3 || (hora === 3 && min < 45)) return;
        const hoy = getFechaHoy();
        const { data: flag } = await supabase.from('bot_config').select('valor').eq('clave', 'penalizacion_ultimo_run').maybeSingle();
        if (flag && flag.valor === hoy) return;
        console.log('⏰ Scheduler penalizaciones: iniciando...');
        const { data: users } = await supabase.from('usuarios').select('*');
        if (!users || users.length === 0) {
            await supabase.from('bot_config').upsert({ clave: 'penalizacion_ultimo_run', valor: hoy });
            return;
        }
        let penOp = 0;
        let penExp = 0;
        for (const user of users) {
            // 1. Penalización !op (si no tiró hoy y tenía usos pendientes)
            if (user.ultimo_op_fecha !== hoy) {
                const usosAyer = user.op_usos_hoy || 0;
                const usosFaltantes = 3 - usosAyer;
                if (usosFaltantes > 0 && user.ultimo_op_fecha !== null) {
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
                    chequearHakiCambio('armadura', user.armadura, arm);
                    await updateUsuario(user.username, {
                        armadura: arm,
                        op_usos_hoy: 0,
                        ultimo_op_fecha: hoy,
                        racha_ops: 0,
                        op_delta_pendiente: delta
                    });
                    penOp++;
                } else {
                    await updateUsuario(user.username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
                }
            }
            // 2. Penalización explorar (usa la función existente)
            const result = await verificarPenalizacionExplorar(user.username);
            if (result) {
                await updateUsuario(user.username, { explorar_penal_pendiente: result });
                penExp++;
            }
        }
        await supabase.from('bot_config').upsert({ clave: 'penalizacion_ultimo_run', valor: hoy });
        console.log('⏰ Scheduler penalizaciones: completado. OP: ' + penOp + ' | Explorar: ' + penExp);
    } catch (err) {
        console.error('❌ Error schedulerPenalizacionesDiarias:', err);
    }
}

// ============================================
// COMMIT INFO
// ============================================
const RENDER_COMMIT = process.env.RENDER_GIT_COMMIT || null;
let commitInfo = null;

async function cargarCommitInfo() {
    if (!RENDER_COMMIT) {
        commitInfo = { hash: 'local', mensaje: 'Modo local', fecha: new Date().toISOString() };
        return;
    }
    try {
        const response = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/commits/' + RENDER_COMMIT);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        commitInfo = {
            hash: RENDER_COMMIT.substring(0, 7),
            mensaje: (data.commit && data.commit.message) ? data.commit.message.split('\n')[0] : 'Sin mensaje',
            fecha: (data.commit && data.commit.author) ? data.commit.author.date : new Date().toISOString()
        };
    } catch (err) {
        commitInfo = { hash: RENDER_COMMIT.substring(0, 7), mensaje: 'Deploy reciente', fecha: new Date().toISOString() };
    }
}

// ============================================
// FECHAS
// ============================================
const getFechaAyer = () => getFechaOffset(-1);

// ============================================
// RANGOS Y EMOJIS
// ============================================
function getRangoArmadura(puntos, esSupremo) {
    if (esSupremo) return { nombre: 'Supremo', emoji: '👑', idx: 4 };
    if (puntos >= 90) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 70) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 40) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

function getRangoObservacion(puntos, esSupremo) {
    if (esSupremo) return { nombre: 'Supremo', emoji: '👑', idx: 4 };
    if (puntos >= 90) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 70) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 40) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

function getRangoConquistador(puntos, esSupremo) {
    if (esSupremo) return { nombre: 'Supremo', emoji: '👑', idx: 4 };
    if (puntos >= 95) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 80) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 60) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

// Puntos por posta: 1ra = +1, 2da = +1, 3ra = +2
const PUNTOS_POSTAS = [1, 1, 2];

// Umbrales de minutos: 10 / 30 / 60
function calcularPostasPorMinutos(minutos) {
    if (minutos >= 60) return 3;
    if (minutos >= 30) return 2;
    if (minutos >= 10) return 1;
    return 0;
}

// Puntos por las primeras N postas (1 a 3)
function calcularPuntosPostas(desde, hasta) {
    let total = 0;
    for (let i = desde; i < hasta && i < 3; i++) total += PUNTOS_POSTAS[i];
    return total;
}

function calcularBonusRacha(racha) {
    if (racha <= 1) return 0;
    return (racha % 5 === 0) ? 5 : 1;
}

// Filtro de episodio: ¿la fruta pasa el filtro del canal?
function pasaFiltroEpisodio(fruta, filtro) {
    if (!filtro || filtro === 'manga') return true;
    if (filtro === 'anime') return fruta.episodio_anime !== null && fruta.episodio_anime !== undefined;
    const limite = parseInt(filtro);
    if (isNaN(limite)) return true;
    return fruta.episodio_anime !== null && fruta.episodio_anime !== undefined && fruta.episodio_anime <= limite;
}
function getCalaverasPorProb(prob) {
    if (prob > 0.78) return '💀';
    if (prob > 0.60) return '💀💀';
    if (prob > 0.40) return '💀💀💀';
    if (prob > 0.18) return '💀💀💀💀';
    return '💀💀💀💀💀';
}

// Para Supremos de Observación: muestra calaveras + % exacto
function formatearProbExplorar(prob, esSupObs) {
    const cal = getCalaverasPorProb(prob);
    if (!esSupObs) return cal;
    return cal + ' (' + (prob * 100).toFixed(1) + '%)';
}

// ============================================
// !op
// ============================================
function getIntervaloTirada(rango) {
    const intervalos = {
        'No despertado': { min: 1, max: 5 },
        'Despertado': { min: -1, max: 4 },
        'Básico': { min: -2, max: 3 },
        'Avanzado': { min: -3, max: 4 },
        'Supremo': { min: -4, max: 2 }
    };
    return intervalos[rango] || { min: 0, max: 0 };
}

const tiradaAleatoria = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function getBonusDiario(rango) {
    const b = { 'No despertado': 5, 'Despertado': 4, 'Básico': 3, 'Avanzado': 2, 'Supremo': 1 };
    return b[rango] || 0;
}

function getBonusRachaOp(dias) {
    if (dias % 10 === 0) return 10;
    if (dias % 5 === 0) return 5;
    return 1;
}

function getTextoResultadoOp(rango, delta) {
    const textos = {
        positivo: { 'No despertado': '¡Sentís una chispa interior!', 'Despertado': '¡Tu espíritu se enciende!', 'Básico': '¡Tu cuerpo se vuelve más duro!', 'Avanzado': '¡Tu voluntad es inquebrantable!', 'Supremo': '¡Nadie puede detenerte!' },
        negativo: { 'No despertado': 'Tu Haki se resiste...', 'Despertado': 'El entrenamiento fue duro...', 'Básico': 'Golpeaste mal y perdiste fuerza...', 'Avanzado': 'Tu Armadura flaqueó un instante...', 'Supremo': 'Hasta los más fuertes fallan...' },
        neutro: { 'No despertado': 'Nada cambió... pero no te rindas.', 'Despertado': 'Tu Haki está estable.', 'Básico': 'Hoy no hubo cambios, pero seguís firme.', 'Avanzado': 'Nada te mueve, ni siquiera la suerte.', 'Supremo': 'Nada puede tocarte, ni el azar.' }
    };
    const tipo = delta > 0 ? 'positivo' : delta < 0 ? 'negativo' : 'neutro';
    return textos[tipo][rango] || 'Sin cambios.';
}

const MENSAJES_RANGO_ARMADURA = {
    'Despertado': '💡 ¡Felicidades! Tu Haki de Armadura ha despertado.',
    'Básico': '💪 ¡Tu defensa se vuelve confiable! Nivel Básico alcanzado.',
    'Avanzado': '🔥 ¡Impresionante! Tu Armadura tiene gran poder. Rango Avanzado.',
    'Supremo': '👑 ¡Como un emperador del mar! Has dominado el Haki de Armadura. SUPREMO.'
};

const MENSAJES_RANGO_OBS = {
    1: '🗺️ Abriste los ojos por primera vez. Ahora debés aprender a ver.',
    2: '✨ Una chispa de percepción se enciende en vos. Despertaste.',
    3: '🔍 Ya no se te escapan los detalles. Rango Básico desbloqueado.',
    4: '🔥 ¡Impresionante! Ya no solo percibís el presente... vislumbrás destellos del futuro. Rango Avanzado.',
    5: '👑 ¡Como un emperador del mar! El futuro entero se abre ante vos. SUPREMO.'
};

// ============================================
// RECOMPENSA Y PENALIZACIÓN
// ============================================
function calcularRecompensaFruta(fruta, fruta2, pcf1, pcf2) {
    // Yami sola o con segunda: valores fijos
    const tieneYami = (fruta === 'Yami Yami no Mi') || (fruta2 === 'Yami Yami no Mi');
    if (tieneYami && (fruta && fruta2)) return 600000000;
    if (tieneYami) return 400000000;
    // Fruta normal: fórmula exponencial con el PCF
    let pcf = 0;
    if (fruta && pcf1) pcf = Math.max(pcf, pcf1);
    if (fruta2 && pcf2) pcf = Math.max(pcf, pcf2);
    if (pcf <= 0) return 0;
    return Math.round(((pcf * pcf) / 150 + (pcf / 3)) * 1000000);
}

async function getRecompensaReal(user) {
    if (!user) return 0;
    const cached = recompCache[user.username];
    if (cached && Date.now() - cached.timestamp < PCF_RECOMP_CACHE_TTL) {
        return cached.data;
    }
    const supArm = await esSupremoArmadura(user.username);
    const supObs = await esSupremoObservacion(user.username);
    const supConq = await esSupremoConquistador(user.username);
    const valorArm = calcularAporteArmadura(user.armadura || 0, supArm) * FACTOR_RECOMPENSA;
    const valorObs = calcularAporteObservacion(user.observacion || 0, supObs) * FACTOR_RECOMPENSA;
    const valorConq = calcularAporteConquistador(user.conquistador || 0, supConq) * FACTOR_RECOMPENSA;
    // PCFs de frutas
    // Yami (o sin fruta) no necesita PCF: la rama de Yami en calcularRecompensaFruta
    // usa valores fijos ($400M / $600M). Fruta normal → 1 query.
    // fruta_2 solo existe con Yami (regla del juego), y en ese caso no se consulta.
    let pcf1 = 0, pcf2 = 0;
    if (user.fruta && user.fruta !== 'Yami Yami no Mi') {
        const { data: f1 } = await supabase.from('frutas').select('poder_fruta').eq('nombre', user.fruta).single();
        pcf1 = (f1 && f1.poder_fruta) ? Number(f1.poder_fruta) : 0;
    }
    const valorFruta = calcularRecompensaFruta(user.fruta, user.fruta_2, pcf1, pcf2);
    const base = valorArm + valorObs + valorConq + valorFruta;
    // Actualizar max histórico si subió
    const maxHist = user.max_base_historica || 0;
    let maxActualizado = maxHist;
    if (base > maxHist) {
        maxActualizado = Math.round(base);
        await updateUsuario(user.username, { max_base_historica: maxActualizado });
    }
    // Delta activo: positivos con tope, negativos con piso -base/3
    const tope = Math.round(maxActualizado * TOPE_DELTA_MULT);
    const pisoNeg = -Math.round(base / 3);
    const deltaRaw = user.recompensa_delta || 0;
    const deltaActivo = Math.min(Math.max(deltaRaw, pisoNeg), tope);
    const result = redondearBonito(Math.round(base + deltaActivo));
    recompCache[user.username] = { data: result, timestamp: Date.now() };
    return result;
}

const PENALIZACION_BASES = {
    no_despertado: { conq: 1, berries: 5000000 },
    despertado:    { conq: 2, berries: 10000000 },
    basico:        { conq: 3, berries: 20000000 },
    avanzado:      { conq: 5, berries: 30000000 },
    supremo:       { conq: 8, berries: 50000000 }
};

function getRangoConquistadorTexto(puntos) {
    if (puntos < 60) return 'no_despertado';
    if (puntos <= 79) return 'despertado';
    if (puntos <= 94) return 'basico';
    if (puntos <= 100) return 'avanzado';
    return 'supremo';
}

const penalCache = {};

async function verificarPenalizacionExplorar(username) {
    const hoy = getFechaHoy();
    // Cache en memoria: si ya chequeamos a este usuario hoy, salir sin tocar la DB
    if (penalCache[username] === hoy) return null;
    const user = await getUsuario(username);
    if (!user) return null;
    if (user.ultimo_dia_penalizacion === hoy) {
        penalCache[username] = hoy;
        return null;
    }
    // Marcar que chequeé hoy (independiente de si exploró o no)
    penalCache[username] = hoy;

    // Caso A: nunca exploró → 1 solo update
    if (!user.ultimo_dia_exploracion) {
        await updateUsuario(username, { ultimo_dia_penalizacion: hoy, dias_sin_explorar: 0 });
        return null;
    }

    const ultimo = new Date(user.ultimo_dia_exploracion);
    const ahora = new Date(hoy);
    const diffDays = Math.floor((ahora - ultimo) / (1000 * 60 * 60 * 24));
    const expected = Math.max(diffDays - 1, 0);
    const capped = Math.min(expected, 4);

    // Caso C: ya estaba al día → solo marcar hoy
    if (capped <= (user.dias_sin_explorar || 0)) {
        await updateUsuario(username, { ultimo_dia_penalizacion: hoy });
        return null;
    }

    // Caso B: hay penalización → 1 solo update con todo
    const rangoConq = getRangoConquistadorTexto(user.conquistador || 0);
    const base = PENALIZACION_BASES[rangoConq];
    const perdConqTeorico = base.conq * capped;
    const perdBerries = base.berries * capped;

    // Piso 1 de Conquistador:
    //   - si tenía >= 1, se resta con piso 1 (nunca baja a 0)
    //   - si tenía 0, no se toca (evita subirlo a 1 por castigo)
    const conqActual = user.conquistador || 0;
    let conqNuevo = conqActual;
    let perdConqAplicado = 0;
    if (conqActual >= 1) {
        conqNuevo = Math.max(conqActual - perdConqTeorico, 1);
        perdConqAplicado = conqActual - conqNuevo;
    }

    chequearHakiCambio('conquistador', conqActual, conqNuevo);
    await updateUsuario(username, {
        ultimo_dia_penalizacion: hoy,
        dias_sin_explorar: capped,
        conquistador: conqNuevo,
        recompensa_delta: (user.recompensa_delta || 0) - perdBerries
    });
    return { dias: capped, perdConq: perdConqAplicado, perdConqTeorico, perdBerries };
}

// ============================================
// SUPREMOS (top 12 por Haki + cupos según usuarios totales)
// ============================================
const SUPREMOS_CACHE_TTL = 30000;
const SUPREMOS_TOP_LIMITE = 12;
let supremosCacheArm = { data: [], timestamp: 0 };
let supremosCacheObs = { data: [], timestamp: 0 };
let supremosCacheConq = { data: [], timestamp: 0 };
// Si un Haki se marca sucio, el scheduler recalcula su tabla en ≤ 30s.
const hakiSucia = { armadura: false, observacion: false, conquistador: false };

function marcarHakiSucia(haki) {
    if (haki === 'armadura' || haki === 'observacion' || haki === 'conquistador') {
        hakiSucia[haki] = true;
    }
}

// Marca sucia si el cambio es "relevante":
// - Estaba o quedó en rango Avanzado o más (90/90/95)
// - Cruzó la barrera de 100 (en cualquier dirección)
function chequearHakiCambio(haki, antes, despues) {
    const a = antes || 0;
    const d = despues || 0;
    if (a === d) return;
    const umbral = (haki === 'conquistador') ? 95 : 90;
    const antesRel = a >= umbral;
    const despuesRel = d >= umbral;
    const cruzo100 = (a < 100 && d >= 100) || (a >= 100 && d < 100);
    if (antesRel || despuesRel || cruzo100) marcarHakiSucia(haki);
}

// Cupos según cantidad total de usuarios
function calcularPlazasSupremos(total) {
    if (total <= 10) return 1;
    if (total <= 20) return 2;
    if (total <= 40) return 3;
    if (total <= 70) return 4;
    if (total <= 99) return 5;
    if (total <= 149) return 6;
    return 7;
}

// Recalcula la tabla supremos para un Haki: top 12 usuarios con > 0 puntos
async function actualizarTablaSupremos(haki) {
    const { data } = await supabase
        .from('usuarios')
        .select('username, ' + haki)
        .gt(haki, 0)
        .order(haki, { ascending: false })
        .limit(SUPREMOS_TOP_LIMITE);
    const rows = (data || []).map(u => ({
        haki,
        username: u.username,
        puntos: u[haki] || 0,
        tipo: 'puntos',
        actualizado: new Date().toISOString()
    }));
    await supabase.from('supremos').delete().eq('haki', haki);
    if (rows.length > 0) {
        await supabase.from('supremos').insert(rows);
    }
    // Invalidar cache de este haki
    if (haki === 'armadura') supremosCacheArm = { data: [], timestamp: 0 };
    if (haki === 'observacion') supremosCacheObs = { data: [], timestamp: 0 };
    if (haki === 'conquistador') supremosCacheConq = { data: [], timestamp: 0 };
}

// Calcula los Supremos reales de un Haki:
// 1. Lee los 12 de la tabla.
// 2. De esos, filtra los que tienen ≥ 100 puntos.
// 3. Aplica cupos (según total de usuarios en la DB).
// 4. Para Observación: garantizados entran primero y ocupan cupos.
// 5. Empates en el corte → entran todos.
async function calcularSupremos(haki, cache) {
    const ahora = Date.now();
    if (ahora - cache.timestamp < SUPREMOS_CACHE_TTL) return cache.data;
    try {
        // 1. Total usuarios para cupos
        const { count } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
        const plazas = calcularPlazasSupremos(count || 0);
        // 2. Leer la tabla supremos de ese Haki
        const { data: tabla } = await supabase
            .from('supremos')
            .select('username, puntos')
            .eq('haki', haki)
            .order('puntos', { ascending: false });
        const elegibles = (tabla || []).filter(r => r.puntos >= 100);
        // Armar resultado: top N por puntos, empates entran todos
        const result = new Set();
        if (elegibles.length > 0) {
            const corteIdx = Math.min(plazas, elegibles.length) - 1;
            const valorCorte = elegibles[corteIdx].puntos;
            for (const e of elegibles) {
                if (e.puntos >= valorCorte) result.add(e.username.toLowerCase());
            }
        }
        const arr = Array.from(result);
        cache.data = arr;
        cache.timestamp = ahora;
        return arr;
    } catch (err) {
        console.error('❌ Error calcularSupremos ' + haki + ':', err);
        return [];
    }
}

async function esSupremoArmadura(username) {
    const arr = await calcularSupremos('armadura', supremosCacheArm);
    return arr.includes(username.toLowerCase());
}
async function esSupremoObservacion(username) {
    const arr = await calcularSupremos('observacion', supremosCacheObs);
    return arr.includes(username.toLowerCase());
}
async function esSupremoConquistador(username) {
    const arr = await calcularSupremos('conquistador', supremosCacheConq);
    return arr.includes(username.toLowerCase());
}

// ============================================
// COMBATE Y PCF
// ============================================
function calcularAporteArmadura(puntos, esSupremo) {
    if (esSupremo) return 250;
    const p = puntos || 0;
    if (p >= 100) return 250;
    if (p >= 90) return 200;
    if (p >= 70) return Math.floor(125 + (p - 70) * 37 / 19);
    if (p >= 40) return Math.floor(50 + (p - 40) * 37 / 29);
    if (p >= 1) return Math.floor(1 + (p - 1) * 24 / 38);
    return 0;
}
function calcularAporteObservacion(puntos, esSupremo) {
    if (esSupremo) return 180;
    const p = puntos || 0;
    if (p >= 100) return 180;
    if (p >= 90) return 144;
    if (p >= 70) return Math.floor(90 + (p - 70) * 27 / 19);
    if (p >= 40) return Math.floor(36 + (p - 40) * 27 / 29);
    if (p >= 1) return Math.floor(1 + (p - 1) * 17 / 38);
    return 0;
}
function calcularAporteConquistador(puntos, esSupremo) {
    if (esSupremo) return 400;
    const p = puntos || 0;
    if (p > 100) return 400;
    if (p >= 95) return 250;
    if (p >= 80) return Math.floor(150 + (p - 80) * 50 / 14);
    if (p >= 60) return Math.floor(100 + (p - 60) * 25 / 19);
    if (p >= 1) return Math.floor(1 + (p - 1) * 49 / 58);
    return 0;
}

async function calcularPCFUsuario(user) {
    // Cache
    const cached = pcfCache[user.username];
    if (cached && Date.now() - cached.timestamp < PCF_RECOMP_CACHE_TTL) {
        return cached.data;
    }
    // PCF de frutas (una sola query para 1 o 2 frutas)
    let poderFruta = 0;
    const frutasUser = [user.fruta, user.fruta_2].filter(Boolean);
    if (frutasUser.length > 0) {
        const { data: frutasData } = await supabase.from('frutas').select('poder_fruta').in('nombre', frutasUser);
        for (const f of (frutasData || [])) poderFruta += (f.poder_fruta || 0);
    }
    const supArm = await esSupremoArmadura(user.username);
    const supObs = await esSupremoObservacion(user.username);
    const supConq = await esSupremoConquistador(user.username);
    const aporte = calcularAporteArmadura(user.armadura || 0, supArm)
        + calcularAporteObservacion(user.observacion || 0, supObs)
        + calcularAporteConquistador(user.conquistador || 0, supConq);
    const result = Math.round(poderFruta + aporte);
    pcfCache[user.username] = { data: result, timestamp: Date.now() };
    return result;
}

async function formatearHakiLog(user) {
    if (!user) return 'N/A';
    const supArm = await esSupremoArmadura(user.username);
    const supObs = await esSupremoObservacion(user.username);
    const supConq = await esSupremoConquistador(user.username);
    const fmt = (v, s) => (s ? 'S' : '') + Math.round(v || 0);
    return fmt(user.armadura, supArm) + '/' + fmt(user.observacion, supObs) + '/' + fmt(user.conquistador, supConq);
}

function aplicarVariacion(poder) {
    return poder * (950 + Math.floor(Math.random() * 101)) / 1000;
}

function calcularCombate(poderUsuario, poderEnemigo) {
    const pfU = aplicarVariacion(poderUsuario);
    const pfE = aplicarVariacion(poderEnemigo);
    return {
        victoria: pfU > pfE,
        porcentaje: ((pfU - pfE) / pfE) * 100
    };
}

function obtenerMensajeCombate(victoria, porcentaje) {
    const cat = victoria ? 'victoria' : 'derrota';
    const absP = Math.abs(porcentaje);
    const rango = absP > 50 ? 'aplastante' : absP >= 20 ? 'clara' : absP >= 5 ? 'ajustada' : 'por_los_pelos';
    const m = {
        victoria: {
            aplastante: ['¡VICTORIA ARROLLADORA!', '¡HAS DEVASTADO A TU RIVAL!'],
            clara: ['¡VICTORIA CONTUNDENTE!', '¡TRIUNFO SIN DISCUSIÓN!'],
            ajustada: ['¡VICTORIA SUDADA!', '¡VICTORIA POR LOS JUSTOS!'],
            por_los_pelos: ['¡VICTORIA AGÓNICA!', '¡VICTORIA MILAGROSA!']
        },
        derrota: {
            aplastante: ['DERROTA ANIQUILADORA.', 'HAS SIDO BARRIDO.'],
            clara: ['DERROTA CLARA.', 'DERROTA SIN PALIATIVOS.'],
            ajustada: ['DERROTA AJUSTADA.', 'DERROTA POR POCO.'],
            por_los_pelos: ['DERROTA POR LOS PELOS.', 'DERROTA INEXTREMIS.']
        }
    };
    const pool = m[cat][rango] || m[cat]['ajustada'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================
// EXPLORAR
// ============================================
function calcularProbabilidadVictoria(pcfU, pcfN) {
    const r = pcfN / pcfU;
    return 1 / (1 + Math.pow(r, EXP_PROB));
}
function getEscalon(ratio) {
    if (ratio <= 0.5) return 'mucho_mas_fuerte';
    if (ratio <= 0.75) return 'mas_fuerte';
    if (ratio <= 1.25) return 'parejo';
    if (ratio <= 1.5) return 'mas_debil';
    return 'mucho_mas_debil';
}
function redondearBerries(v) { return Math.round(v / 10000) * 10000; }

// Rangos por recompensa — umbrales (extraídos a constantes para facilitar tuning)
const UMBRAL_YONKO = 3000000000;       // $3B
const UMBRAL_SHICHIBUKAI = 1000000000;  // $1B
const UMBRAL_SUPERNOVA = 300000000;    // $300M
const RANKING_SLOTS_MAX = 22;          // 4 yonko + 7 shichibukai + 11 supernova

// Rangos por recompensa (Yonko / Shichibukai / Supernova)
async function actualizarRangosRecompensa(usernameDisparador) {
    // PASO 1: leer al disparador (1 query por PK)
    let disparadorEstaEnRanking = false;
    let disparadorRecompensa = 0;
    if (usernameDisparador) {
        const { data: u } = await supabase
            .from('usuarios')
            .select('recompensa_publica')
            .eq('username', usernameDisparador)
            .maybeSingle();
        disparadorRecompensa = (u && u.recompensa_publica) || 0;

        // PASO 2: ¿ya está en el ranking? (1 query por PK)
        const { data: r } = await supabase
            .from('ranking_recompensa')
            .select('username')
            .eq('username', usernameDisparador)
            .maybeSingle();
        disparadorEstaEnRanking = !!r;
    }

    // PASO 3: skip temprano — no está en ranking y no llega al piso absoluto
    if (usernameDisparador && !disparadorEstaEnRanking && disparadorRecompensa < UMBRAL_SUPERNOVA) {
        return null;
    }

    // PASO 4: leer el ranking actual completo
    const { data: rankingActual } = await supabase
        .from('ranking_recompensa')
        .select('username, rango, recompensa_publica')
        .order('recompensa_publica', { ascending: false });
    const rankingActualArr = rankingActual || [];

    // PASO 5: skips por slots/minActual (solo si el disparador no está en el ranking)
    if (usernameDisparador && !disparadorEstaEnRanking) {
        const haySlotsLibres = rankingActualArr.length < RANKING_SLOTS_MAX;
        if (!haySlotsLibres) {
            const minActual = rankingActualArr[rankingActualArr.length - 1].recompensa_publica || 0;
            if (disparadorRecompensa <= minActual) return null;
        }
    }

    // PASO 6: recalcular candidatos (LIMIT 22, era 60)
    const { data } = await supabase
        .from('usuarios')
        .select('username, recompensa_publica')
        .gte('recompensa_publica', UMBRAL_SUPERNOVA)
        .order('recompensa_publica', { ascending: false })
        .limit(RANKING_SLOTS_MAX);

    if (!data || data.length === 0) {
        if (rankingActualArr.length === 0) return [];
        await supabase.from('ranking_recompensa').delete().neq('username', '___imposible___');
        return [];
    }

    const yonkos = [];
    const shichibukais = [];
    const supernovas = [];
    let pool = [...data];
    // Yonko: top 4, > $3B
    for (const u of pool) {
        if (yonkos.length >= 4) break;
        if (u.recompensa_publica > UMBRAL_YONKO) yonkos.push(u.username);
    }
    pool = pool.filter(u => !yonkos.includes(u.username));
    // Shichibukai: top 7, > $1B
    for (const u of pool) {
        if (shichibukais.length >= 7) break;
        if (u.recompensa_publica > UMBRAL_SHICHIBUKAI) shichibukais.push(u.username);
    }
    pool = pool.filter(u => !shichibukais.includes(u.username));
    // Supernova: top 11, > $300M
    for (const u of pool) {
        if (supernovas.length >= 11) break;
        if (u.recompensa_publica > UMBRAL_SUPERNOVA) supernovas.push(u.username);
    }

    const recompensaPorUser = {};
    for (const u of data) recompensaPorUser[u.username] = u.recompensa_publica;
    const rows = [
        ...yonkos.map(u => ({ username: u, rango: 'yonko', recompensa_publica: recompensaPorUser[u] || 0 })),
        ...shichibukais.map(u => ({ username: u, rango: 'shichibukai', recompensa_publica: recompensaPorUser[u] || 0 })),
        ...supernovas.map(u => ({ username: u, rango: 'supernova', recompensa_publica: recompensaPorUser[u] || 0 }))
    ];

    // PASO 7: skip de escritura si el ranking no cambió
    const mapActual = {};
    for (const r of rankingActualArr) mapActual[r.username] = r.rango + '|' + Number(r.recompensa_publica || 0);
    const mapNuevo = {};
    for (const r of rows) mapNuevo[r.username] = r.rango + '|' + Number(r.recompensa_publica || 0);
    const mismoTamano = Object.keys(mapActual).length === Object.keys(mapNuevo).length;
    const todoIgual = mismoTamano && Object.keys(mapNuevo).every(k => mapActual[k] === mapNuevo[k]);
    if (todoIgual) return rows;

    // PASO 8: escribir (solo si cambió)
    await supabase.from('ranking_recompensa').delete().neq('username', '___imposible___');
    await supabase.from('ranking_recompensa').insert(rows);
    return rows;
}

async function getRangoRecompensa(username) {
    const { data } = await supabase.from('ranking_recompensa')
        .select('rango').eq('username', username).maybeSingle();
    return data ? data.rango : null;
}

function getEmojiRango(rango) {
    if (rango === 'yonko') return '🏴‍☠️👑';
    if (rango === 'shichibukai') return '🏴‍☠️⚔️🌊';
    if (rango === 'supernova') return '🏴‍☠️💫';
    return '';
}

function getNombreRango(rango) {
    if (rango === 'yonko') return 'Yonko';
    if (rango === 'shichibukai') return 'Shichibukai';
    if (rango === 'supernova') return 'Supernova';
    return '';
}

// ============================================
// COLISEO — HELPERS
// ============================================
async function getColiseo(canal) {
    const { data } = await supabase.from('coliseo').select('*').eq('canal', canal).maybeSingle();
    return data;
}

async function guardarColiseo(canal, datos) {
    await supabase.from('coliseo').upsert({ canal, actualizado: new Date().toISOString(), ...datos });
}

async function borrarColiseo(canal) {
    await supabase.from('coliseo').delete().eq('canal', canal);
}

function getEmojiRangoColiseo(rango) {
    if (rango === 1) return '🥇';
    if (rango === 2) return '🥈';
    if (rango === 3) return '🥉';
    return '';
}

function calcularProbabilidadBR(pcfUsuario, pcfSumaOtros) {
    if (pcfSumaOtros <= 0) return 1;
    if (pcfUsuario <= 0) return 0;
    const r = pcfSumaOtros / pcfUsuario;
    return 1 / (1 + Math.pow(r, COLISEO_EXP_BR));
}

function sortearBR(participantes) {
    // Devuelve un array ordenado por puesto (1º, 2º, 3º...)
    const restantes = [...participantes];
    const resultado = [];
    while (restantes.length > 0) {
        const pcfTotal = restantes.reduce((s, p) => s + (p.pcf || 0), 0);
        const probs = restantes.map(p => {
            const otros = pcfTotal - (p.pcf || 0);
            return calcularProbabilidadBR(p.pcf || 0, otros);
        });
        const sumaProbs = probs.reduce((s, v) => s + v, 0);
        const normalizadas = probs.map(p => p / sumaProbs);
        let r = Math.random();
        let idx = 0;
        for (let i = 0; i < normalizadas.length; i++) {
            r -= normalizadas[i];
            if (r <= 0) { idx = i; break; }
            idx = i;
        }
        resultado.push(restantes[idx]);
        restantes.splice(idx, 1);
    }
    return resultado;
}

// Costo de entrada al Coliseo según la probabilidad de ganar (bandas)
function calcularCostoColiseo(prob) {
    let conq;
    if (prob <= 0.20) conq = 1;
    else if (prob <= 0.40) conq = 2;
    else if (prob <= 0.60) conq = 3;
    else if (prob <= 0.80) conq = 4;
    else conq = 5;
    return { conq, berries: conq * COLISEO_BERRIES_POR_CONQ };
}

async function repartirPremiosColiseo(participantes, ordenGanadores) {
    // participantes: array de {username, pcf, costo_conq, costo_berries, conquistador_actual, forzar_derrota?}
    // ordenGanadores: array ordenado por puesto (1º, 2º, 3º...)
    const total = participantes.length;
    const numPremios = total >= 5 ? 2 : 1;
    const potConq = participantes.reduce((s, p) => s + (p.costo_conq || 0), 0);
    const potBerries = participantes.reduce((s, p) => s + (p.costo_berries || 0), 0);
    // Premios: 1 premio = 100%, 2 premios = 70/30
    let premiosConq, premiosBerries;
    if (numPremios === 1) {
        premiosConq = [potConq];
        premiosBerries = [potBerries];
    } else {
        const p1Conq = Math.floor(potConq * 0.70);
        const p1Berries = Math.floor(potBerries * 0.70);
        premiosConq = [p1Conq, potConq - p1Conq];
        premiosBerries = [p1Berries, potBerries - p1Berries];
    }
    // Netos por ganador (premio - costo)
    const ganadores = ordenGanadores.slice(0, numPremios);
    const perdedores = ordenGanadores.slice(numPremios);
    const netosConq = [];
    const netosBerries = [];
    for (let i = 0; i < ganadores.length; i++) {
        netosConq.push(premiosConq[i] - (ganadores[i].costo_conq || 0));
        netosBerries.push(premiosBerries[i] - (ganadores[i].costo_berries || 0));
    }
    // Mitigación de neto negativo en ganadores (solo puede disparar en el 2º de 5+)
    if (numPremios === 2) {
        if (netosConq[1] < 0) {
            netosConq[0] += netosConq[1];
            netosConq[1] = 0;
        }
        if (netosBerries[1] < 0) {
            netosBerries[0] += netosBerries[1];
            netosBerries[1] = 0;
        }
    }
    // Aplicar a ganadores + capturar datos para mensajes
    for (let i = 0; i < ganadores.length; i++) {
        const u = ganadores[i].username;
        const userU = await getUsuario(u);
        if (!userU) continue;
        const deltaConq = netosConq[i];
        const deltaBerries = netosBerries[i];
        chequearHakiCambio('conquistador', userU.conquistador, Math.max((userU.conquistador || 0) + deltaConq, 0));
        await updateUsuario(u, {
            conquistador: Math.max((userU.conquistador || 0) + deltaConq, 0),
            recompensa_delta: (userU.recompensa_delta || 0) + deltaBerries,
            coliseo_canal: null
        });
    }
    // Aplicar a perdedores + capturar quién puede recibir susurro
    const susurrosPerdedores = [];
    const perdedoresChat = []; // { username, costo_conq, costo_berries }
    for (const p of perdedores) {
        const userP = await getUsuario(p.username);
        if (!userP) continue;
        const deltaConq = -(p.costo_conq || 0);
        const deltaBerries = -(p.costo_berries || 0);
        chequearHakiCambio('conquistador', userP.conquistador, Math.max((userP.conquistador || 0) + deltaConq, 0));
        await updateUsuario(p.username, {
            conquistador: Math.max((userP.conquistador || 0) + deltaConq, 0),
            recompensa_delta: (userP.recompensa_delta || 0) + deltaBerries,
            coliseo_canal: null
        });
        const pc = Math.round(p.costo_conq || 0);
        const pb = Math.round(p.costo_berries || 0);
        const msgSusurro = '🏟️ Coliseo: quedaste eliminado. -' + pc + ' Conq / -$' + formatBerries(pb) + '.';
        if (userP.ha_susurrado && userP.twitch_user_id) {
            susurrosPerdedores.push({
                username: userP.username,
                twitch_user_id: userP.twitch_user_id,
                mensaje: msgSusurro
            });
        } else {
            perdedoresChat.push({ username: userP.username, costo_conq: pc, costo_berries: pb });
        }
    }
    // ============================================
    // ARMAR MENSAJES
    // ============================================
    // msgGanadores: siempre
    // msgPerdedoresChat: null si no hay perdedores sin susurro
    // susurrosPerdedores: array (vacío si todos tienen ha_susurrado)
    let msgGanadores = '';
    let msgPerdedoresChat = null;
    if (total === 2) {
        // 1v1 unificado
        const g = ganadores[0];
        const p = perdedores[0];
        const gc = Math.round(netosConq[0]);
        const gb = Math.round(netosBerries[0]);
        const pc = Math.round(p.costo_conq || 0);
        const pb = Math.round(p.costo_berries || 0);
        const gcb = (gc >= 0 ? '+' : '') + gc + ' Conq';
        const gbb = (gb >= 0 ? '+' : '-') + '$' + formatBerries(Math.abs(gb));
        msgGanadores = '🏟️ @' + g.username + ' venció a @' + p.username + ' | @' + g.username + ': ' + gcb + ' / ' + gbb + ' | @' + p.username + ': -' + pc + ' Conq / -$' + formatBerries(pb);
        // En 1v1, la parte de perdedores ya está en msgGanadores. No hay chat ni susurro extra.
        return { msgGanadores, msgPerdedoresChat: null, susurrosPerdedores: [] };
    } else if (total <= 4) {
        // BR chico, 1 premio
        const g = ganadores[0];
        const gc = Math.round(netosConq[0]);
        const gb = Math.round(netosBerries[0]);
        const gcb = (gc >= 0 ? '+' : '') + gc + ' Conq';
        const gbb = (gb >= 0 ? '+' : '-') + '$' + formatBerries(Math.abs(gb));
        msgGanadores = '🏟️ ¡' + total + ' gladiadores! 🥇 @' + g.username + ' se lleva todo: ' + gcb + ' / ' + gbb + '.';
    } else {
        // BR grande, 2 premios
        const g1 = ganadores[0];
        const g2 = ganadores[1];
        const g1c = Math.round(netosConq[0]);
        const g1b = Math.round(netosBerries[0]);
        const g2c = Math.round(netosConq[1]);
        const g2b = Math.round(netosBerries[1]);
        const g1cb = (g1c >= 0 ? '+' : '') + g1c + ' Conq';
        const g1bb = (g1b >= 0 ? '+' : '-') + '$' + formatBerries(Math.abs(g1b));
        const g2cb = (g2c >= 0 ? '+' : '') + g2c + ' Conq';
        const g2bb = (g2b >= 0 ? '+' : '-') + '$' + formatBerries(Math.abs(g2b));
        msgGanadores = '🏟️ ¡' + total + ' gladiadores! 🥇 @' + g1.username + ' REINÓ EN LA ARENA: ' + g1cb + ' / ' + g1bb + '. 🥈 @' + g2.username + ': ' + g2cb + ' / ' + g2bb + '.';
    }
    // msgPerdedoresChat (solo si hay perdedores sin susurro en BR)
    if (perdedoresChat.length > 0) {
        const grupos = {};
        for (const p of perdedoresChat) {
            const key = p.costo_conq + '|' + p.costo_berries;
            if (!grupos[key]) grupos[key] = { usuarios: [], costo_conq: p.costo_conq, costo_berries: p.costo_berries };
            grupos[key].usuarios.push('@' + p.username);
        }
        const partes = [];
        for (const k in grupos) {
            const g = grupos[k];
            partes.push(g.usuarios.join(', ') + ': -' + g.costo_conq + ' Conq/-$' + formatBerries(g.costo_berries));
        }
        msgPerdedoresChat = '💀 ' + partes.join(' | ');
    }
    return { msgGanadores, msgPerdedoresChat, susurrosPerdedores };
}


async function usuarioEnColiseo(username) {
    const { data } = await supabase.from('usuarios').select('coliseo_canal').eq('username', username).maybeSingle();
    return data ? data.coliseo_canal : null;
}

async function cerrarVentanaColiseo(coliseo) {
    const canal = coliseo.canal;
    const participantes = coliseo.participantes || [];
    // Recalcular PCF y Conq actual de cada uno (puede haber cambiado durante la ventana)
    for (const p of participantes) {
        const uFresh = await getUsuario(p.username);
        if (uFresh) {
            p.pcf = await calcularPCFUsuario(uFresh);
            p.conquistador_actual = uFresh.conquistador || 0;
        } else {
            p.conquistador_actual = 0;
        }
    }
    // ============================================
    // Caso 1 participante o menos → CANCELAR
    // ============================================
    if (participantes.length <= 1) {
        client.say(canal, '🏟️ El Coliseo se cancela.');
        for (const p of participantes) {
            await updateUsuario(p.username, { coliseo_canal: null });
        }
        await borrarColiseo(canal);
        return;
    }
    // ============================================
    // Caso 2 participantes → 1v1 (verificar 15%)
    // ============================================
    if (participantes.length === 2) {
        const [a, b] = participantes;
        const pcfA = a.pcf || 0;
        const pcfB = b.pcf || 0;
        let probA;
        if (pcfA === 0 && pcfB === 0) probA = 0.5;
        else if (pcfB === 0) probA = 1;
        else if (pcfA === 0) probA = 0;
        else probA = 1 / (1 + Math.pow(pcfB / pcfA, EXP_PROB));
        const probDebil = Math.min(probA, 1 - probA);
        if (probDebil < COLISEO_PROB_MIN) {
            client.say(canal, '🏟️ El Coliseo se cancela: los luchadores no son rivales parejos.');
            for (const p of participantes) {
                await updateUsuario(p.username, { coliseo_canal: null });
            }
            await borrarColiseo(canal);
            return;
        }
        // Asignar costos (capados por conquistador actual)
        const costoA = Math.min(calcularCostoColiseo(probA).conq, Math.max(a.conquistador_actual, 0));
        const costoB = Math.min(calcularCostoColiseo(1 - probA).conq, Math.max(b.conquistador_actual, 0));
        a.costo_conq = costoA;
        a.costo_berries = costoA * COLISEO_BERRIES_POR_CONQ;
        b.costo_conq = costoB;
        b.costo_berries = costoB * COLISEO_BERRIES_POR_CONQ;
        // Resolver 1v1 SIN EMPATE (random < probA)
        const ganador = Math.random() < probA ? a : b;
        const perdedor = ganador === a ? b : a;
        // Aplicar forzar_derrota si existe
        let orden;
        if (a.forzar_derrota && !b.forzar_derrota) orden = [b, a];
        else if (b.forzar_derrota && !a.forzar_derrota) orden = [a, b];
        else orden = [ganador, perdedor];
        // Incrementar coliseos_hoy (recién acá, solo participantes que pelearon)
        for (const p of participantes) {
            const uP = await getUsuario(p.username);
            if (uP) await updateUsuario(p.username, { coliseos_hoy: (uP.coliseos_hoy || 0) + 1 });
        }
        // Repartir
        const resPremios = await repartirPremiosColiseo(participantes, orden);
        client.say(canal, resPremios.msgGanadores);
        // Registrar 1v1 en duelos para !historial.
        // Usamos fecha vieja (2020-01-01) para que contarDuelosHoy NO lo cuente.
        // getHistorialH2H no filtra por fecha, así que sí aparece en !historial.
        const pcfRet = orden[0].pcf || 0;
        const pcfRetado = orden[1].pcf || 0;
        let probRetadorDuelo;
        if (pcfRet === 0 && pcfRetado === 0) probRetadorDuelo = 0.5;
        else if (pcfRetado === 0) probRetadorDuelo = 1;
        else if (pcfRet === 0) probRetadorDuelo = 0;
        else probRetadorDuelo = 1 / (1 + Math.pow(pcfRetado / pcfRet, EXP_PROB));
        await crearDuelo({
            retador: orden[0].username, retado: orden[1].username,
            fecha: '2020-01-01T00:00:00+00:00',
            estado: 'finalizado',
            ganador: orden[0].username,
            pcf_retador: pcfRet, pcf_retado: pcfRetado,
            prob_retador: parseFloat(probRetadorDuelo.toFixed(4)),
            monto: 0,
            delta_retador: 0, delta_retado: 0,
            canal: 'op_d_bot'
        });
        const probLogA = (probA * 100).toFixed(1);
        const probLogB = ((1 - probA) * 100).toFixed(1);
        console.log('[COLISEO] ' + canal + ' → 1v1 | ' + a.username + ' (PCF ' + pcfA + ', ' + probLogA + '%, costo ' + costoA + ') vs ' + b.username + ' (PCF ' + pcfB + ', ' + probLogB + '%, costo ' + costoB + ') | Ganador: ' + orden[0].username);
        await borrarColiseo(canal);
        return;
    }
    // ============================================
    // Caso 3+ participantes → BR
    // ============================================
    const pcfTotal = participantes.reduce((s, p) => s + (p.pcf || 0), 0);
    // Calcular prob cruda de cada uno
    for (const p of participantes) {
        const otros = pcfTotal - (p.pcf || 0);
        p.prob_cruda = calcularProbabilidadBR(p.pcf || 0, otros);
    }
    const sumaProbs = participantes.reduce((s, p) => s + p.prob_cruda, 0);
    // Normalizar y asignar costos
    for (const p of participantes) {
        p.prob = sumaProbs > 0 ? p.prob_cruda / sumaProbs : (1 / participantes.length);
        const costo = Math.min(calcularCostoColiseo(p.prob).conq, Math.max(p.conquistador_actual, 0));
        p.costo_conq = costo;
        p.costo_berries = costo * COLISEO_BERRIES_POR_CONQ;
    }
    // Sortear
    const orden = sortearBR(participantes);
    // Aplicar forzar_derrota: mover al dueño al último lugar del orden
    for (const p of participantes) {
        if (p.forzar_derrota) {
            const idx = orden.findIndex(x => x.username === p.username);
            if (idx >= 0) {
                orden.splice(idx, 1);
                orden.push(p);
            }
        }
    }
    // Incrementar coliseos_hoy (recién acá)
    for (const p of participantes) {
        const uP = await getUsuario(p.username);
        if (uP) await updateUsuario(p.username, { coliseos_hoy: (uP.coliseos_hoy || 0) + 1 });
    }
    // Repartir
    const resPremios = await repartirPremiosColiseo(participantes, orden);
    client.say(canal, resPremios.msgGanadores);
    if (resPremios.msgPerdedoresChat) client.say(canal, resPremios.msgPerdedoresChat);
    for (const s of resPremios.susurrosPerdedores) {
        await notificar(s.username, s.twitch_user_id, s.mensaje);
    }
    const detalleBR = participantes.map(p =>
        p.username + '(PCF ' + (p.pcf || 0) + ', ' + (p.prob * 100).toFixed(1) + '%, costo ' + p.costo_conq + ')'
    ).join(' ');
    console.log('[COLISEO] ' + canal + ' → BR ' + participantes.length + ' personas | ' + detalleBR + ' | Ganador: ' + orden[0].username);
    await borrarColiseo(canal);
}

async function revisarColiseosExpirados() {
    try {
        const ahoraISO = new Date().toISOString();
        const { data } = await supabase.from('coliseo')
            .select('*')
            .eq('estado', 'ventana')
            .lt('ventana_fin', ahoraISO);
        for (const c of (data || [])) {
            try { await cerrarVentanaColiseo(c); } catch (e) { console.error('Error cerrando coliseo ' + c.canal + ':', e); }
        }
        // Aviso al dueño si predeploy está activo y ya no quedan ventanas
        if (predeployActivo) {
            const { data: avisado } = await supabase.from('bot_config').select('valor').eq('clave', 'predeploy_avisado').maybeSingle();
            if (!avisado || avisado.valor !== 'true') {
                const ventanas = await contarVentanasColiseo();
                if (ventanas === 0) {
                    const dueñoUser = await getUsuario(DUEÑO);
                    if (dueñoUser) {
                        await notificar(DUEÑO, dueñoUser.twitch_user_id, '✅ Todas las ventanas de coliseo cerradas. Podés hacer el deploy.');
                    }
                    await supabase.from('bot_config').upsert({ clave: 'predeploy_avisado', valor: 'true' });
                }
            }
        }
    } catch (err) { console.error('Error revisarColiseosExpirados:', err); }
}

// Redondea a 4 cifras significativas (ej: 123456789 → 123500000)
function getFactorRango(conq) {
    if (conq < 60) return 1.5;
    if (conq < 80) return 1.25;
    if (conq < 95) return 1.1;
    if (conq < 100) return 1.0;
    return 0.95;
}

function redondearBonito(n) {
    if (!n || n === 0) return 0;
    const signo = n < 0 ? -1 : 1;
    const abs = Math.abs(n);
    const digitos = Math.floor(Math.log10(abs)) + 1;
    const factor = Math.pow(10, Math.max(0, digitos - 4));
    return signo * Math.round(abs / factor) * factor;
}

async function calcularBonusRachaExplorar(user) {
    const hoy = getFechaHoy();
    const ayer = getFechaOffset(-1);
    const ultimoDia = user.ultimo_dia_racha_explorar;
    if (ultimoDia === hoy) {
        return { bonus: 0, racha: user.racha_explorar || 0, yaContado: true };
    }
    let racha = user.racha_explorar || 0;
    if (ultimoDia === ayer) {
        racha += 1;
    } else {
        racha = 1;
    }
    // Bonus por rango de Conquistador:
    //   - No despertado (<60): racha <=10 → 1, racha >10 → 2
    //   - Despertado (60-79) y Básico (80-94): 1
    //   - Avanzado/Supremo (95+): 0
    const conq = user.conquistador || 0;
    let bonus;
    if (conq < 60) {
        bonus = racha <= 10 ? 1 : 2;
    } else if (conq < 95) {
        bonus = 1;
    } else {
        bonus = 0;
    }
    await updateUsuario(user.username, { racha_explorar: racha, ultimo_dia_racha_explorar: hoy });
    return { bonus, racha, yaContado: false };
}

function calcularRecompensasExplorar(npc, prob, victoria, dificultad) {
    // Fórmula exponencial por probabilidad real. Devuelve floats puros.
    // Victoria: mult = 2^((0.5 - prob)/0.38) → 1.0 en 50%, 2.0 en 12%, 0.5 en 88%.
    // Derrota:  mult = 2^((prob - 0.5)/0.2)  → 1.0 en 50%, 2.0 en 82%, 0.5 en 32%.
    // El 4to argumento (dificultad) se mantiene por compatibilidad pero no se usa.
    const baseConq = npc.recompensa_conquistador || 0;
    const baseBerries = npc.recompensa_berries || 0;
    const p = Math.max(prob, 0.01);
    const mult = victoria
        ? Math.max(Math.pow(2, (0.5 - p) / 0.38), 0.05)
        : Math.max(Math.pow(2, (p - 0.5) / 0.2), 0.05);
    return {
        conq: baseConq * mult,
        berries: baseBerries * mult
    };
}
async function getMensajeContextualExplorar(victoria, escalon, margenKey) {
    let s;
    if (victoria) {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey === 'alto') s = 'victoria_underdog_goleada';
        else if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') s = 'victoria_underdog_poco';
        else if (escalon === 'parejo') s = 'victoria_parejo';
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') s = 'victoria_favorito_poco';
        else s = 'victoria_favorito_goleada';
    } else {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') s = 'derrota_underdog_poco';
        else if (escalon === 'mas_debil' || escalon === 'mucho_mas_debil') s = 'derrota_underdog_aplastado';
        else if (escalon === 'parejo') s = 'derrota_parejo';
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') s = 'derrota_favorito_poco';
        else s = 'derrota_favorito_aplastado';
    }
    return await getTextoExplorar(s);
}

async function seleccionarNPCs(pcfUsuario, conq, factorF) {
    const { data: npcs } = await supabase.from('npcs').select('*');
    if (!npcs || npcs.length === 0) return null;
    const elegidos = new Set();
    const resultado = {};
    const orden = ['facil', 'dificil', 'medio'];
    const rangos = { facil: [0.69, 0.88], medio: [0.32, 0.69], dificil: [0.07, 0.32] };
    for (const bucket of orden) {
        const [minP, maxP] = rangos[bucket];
        let cand = npcs.filter(n => {
            if (elegidos.has(n.nombre)) return false;
            const p = n.pcf_final || n.pcf_calculado || 0;
            if (p <= 0) return false;
            const prob = calcularProbabilidadVictoria(pcfUsuario, p);
            return prob >= minP && prob <= maxP;
        });
        if (cand.length === 0) {
            const probMedia = (minP + maxP) / 2;
            const disponibles = npcs.filter(n => {
                if (elegidos.has(n.nombre)) return false;
                const p = n.pcf_final || n.pcf_calculado || 0;
                if (p <= 0) return false;
                const prob = calcularProbabilidadVictoria(pcfUsuario, p);
                return prob <= maxP;
            });
            if (disponibles.length > 0) {
                disponibles.sort((a, b) => {
                    const pa = calcularProbabilidadVictoria(pcfUsuario, a.pcf_final || a.pcf_calculado || 0);
                    const pb = calcularProbabilidadVictoria(pcfUsuario, b.pcf_final || b.pcf_calculado || 0);
                    return Math.abs(pa - probMedia) - Math.abs(pb - probMedia);
                });
                cand = [disponibles[0]];
            }
        }
        if (cand.length === 0 && pcfUsuario < 15) {
            cand = npcs
                .filter(n => {
                    if (elegidos.has(n.nombre)) return false;
                    const p = n.pcf_final || n.pcf_calculado || 0;
                    return p > 0;
                })
                .sort((a, b) => {
                    const pa = a.pcf_final || a.pcf_calculado || 0;
                    const pb = b.pcf_final || b.pcf_calculado || 0;
                    return pa - pb;
                })
                .slice(0, 3);
        }
        if (cand.length === 0) continue;

        let el = cand[Math.floor(Math.random() * cand.length)];
        const pcfNpc = el.pcf_final || el.pcf_calculado || 0;
        let prob = calcularProbabilidadVictoria(pcfUsuario, pcfNpc);
        let victoria = Math.random() < prob;
        let cast = calcularRecompensasExplorar(el, prob, false, bucket);
        let forzadoTipo = null;

        // Red de seguridad: si la derrota (sin F) mandaría a 0 o negativo, buscar alternativa segura.
        if (!victoria && cast.conq > conq) {
            const alternativos = npcs.filter(n => {
                if (elegidos.has(n.nombre)) return false;
                if (n.nombre === el.nombre) return false;
                const p = n.pcf_final || n.pcf_calculado || 0;
                if (p <= 0) return false;
                const pr = calcularProbabilidadVictoria(pcfUsuario, p);
                return pr >= minP && pr <= maxP;
            });
            if (alternativos.length > 0) {
                let minCastigoNpc = null;
                let minCastigoVal = Infinity;
                for (const alt of alternativos) {
                    const p = alt.pcf_final || alt.pcf_calculado || 0;
                    const pr = calcularProbabilidadVictoria(pcfUsuario, p);
                    const c = calcularRecompensasExplorar(alt, pr, false, bucket).conq;
                    if (c < minCastigoVal) {
                        minCastigoVal = c;
                        minCastigoNpc = alt;
                    }
                }
                if (minCastigoVal <= conq) {
                    el = minCastigoNpc;
                    const pcfAlt = el.pcf_final || el.pcf_calculado || 0;
                    prob = calcularProbabilidadVictoria(pcfUsuario, pcfAlt);
                    victoria = Math.random() < prob;
                    cast = calcularRecompensasExplorar(el, prob, false, bucket);
                    forzadoTipo = 'castigo_seguro';
                } else {
                    let minRecNpc = null;
                    let minRecVal = Infinity;
                    for (const alt of alternativos) {
                        const p = alt.pcf_final || alt.pcf_calculado || 0;
                        const pr = calcularProbabilidadVictoria(pcfUsuario, p);
                        const r = calcularRecompensasExplorar(alt, pr, true, bucket).conq;
                        if (r < minRecVal) {
                            minRecVal = r;
                            minRecNpc = alt;
                        }
                    }
                    el = minRecNpc;
                    const pcfAlt = el.pcf_final || el.pcf_calculado || 0;
                    prob = calcularProbabilidadVictoria(pcfUsuario, pcfAlt);
                    victoria = true;
                    cast = calcularRecompensasExplorar(el, prob, false, bucket);
                    forzadoTipo = 'victoria_forzada';
                }
            } else {
                victoria = true;
                forzadoTipo = 'victoria_forzada';
            }
        }

        elegidos.add(el.nombre);
        const pcfNpcFinal = el.pcf_final || el.pcf_calculado || 0;
        const pcfU = aplicarVariacion(pcfUsuario);
        const pcfN = aplicarVariacion(pcfNpcFinal);
        const gan = Math.max(pcfU, pcfN), per = Math.min(pcfU, pcfN);
        const margen = (gan - per) / per;
        const ratio = pcfNpcFinal / pcfUsuario;
        const escalon = getEscalon(ratio);
        const margenKey = margen < 0.10 ? 'bajo' : margen < 0.30 ? 'medio' : 'alto';
        const rec = calcularRecompensasExplorar(el, prob, true, bucket);
        resultado[bucket] = {
            npc: el.nombre, nivel: el.nivel, pcf_npc: pcfNpcFinal, pcf_usuario: pcfUsuario,
            prob, victoria, escalon, margen_key: margenKey,
            recompensa_conq: rec.conq, recompensa_berries: rec.berries,
            castigo_conq: cast.conq, castigo_berries: cast.berries,
            forzado: forzadoTipo
        };
    }
    if (Object.keys(resultado).length < 2) return null;
    return resultado;
}

// Cooldown de exploración: 1 vez por día, reset a las 00:00 AR
async function puedeExplorar(user) {
    const hoy = getFechaHoy();
    if (!user.ultimo_dia_exploracion || user.ultimo_dia_exploracion !== hoy) return { ok: true };
    const ahora = new Date();
    const utcMs = ahora.getTime();
    const arMs = utcMs - (3 * 60 * 60 * 1000);
    const manana = new Date(arMs);
    manana.setUTCDate(manana.getUTCDate() + 1);
    manana.setUTCHours(0, 0, 0, 0);
    return { ok: false, restante: manana.getTime() - arMs };
}

function formatTiempoRestante(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return (s % 60) + 's';
}

// ============================================
// DUELOS
// ============================================
function resolverDuelo(probRetador, retador, retado) {
    const probRetado = 1 - probRetador;
    const probDebil = Math.min(probRetador, probRetado);
    const tieProb = Math.min(0.10, 0.10 * Math.sqrt(2 * probDebil));
    const probDebilFinal = Math.max(0, probDebil - tieProb);
    const r = Math.random();
    if (r < probDebilFinal) return { ganador: probRetador < probRetado ? retador : retado, empate: false };
    if (r < probDebil) return { ganador: null, empate: true };
    return { ganador: probRetador > probRetado ? retador : retado, empate: false };
}

function calcularMontoDuelo(recompensaRetador, recompensaRetado, pcfRetador, pcfRetado, deltaPerdedor, ganadorEsRetador) {
    // Pot = décimo de la suma de recompensas reales
    const pot = (recompensaRetador + recompensaRetado) / 20;
    const pcfPerdedor = ganadorEsRetador ? pcfRetado : pcfRetador;
    const pcfGanador = ganadorEsRetador ? pcfRetador : pcfRetado;
    const recompensaGanador = ganadorEsRetador ? recompensaRetador : recompensaRetado;
    // Multiplicador por diferencia de PCF
    const ratio = pcfPerdedor / pcfGanador;
    const mult = Math.max(0.1, Math.min(5, ratio * ratio));
    let monto = pot * mult;
    // Cap 1: nunca más del 50% de la recompensa del ganador
    monto = Math.min(monto, recompensaGanador * 0.5);
    // Cap 2: si el perdedor tiene delta positivo, nunca más de ese delta
    const deltaPos = Math.max(0, deltaPerdedor);
    if (deltaPos > 0) monto = Math.min(monto, deltaPos);
    return redondearBonito(Math.round(monto));
}

function getSituacionDuelo(ganador, empate, retador, retado, probRetador) {
    if (empate) return 'empate';
    const probRetado = 1 - probRetador;
    const ganEsFuerte = (ganador === retador && probRetador >= probRetado) || (ganador === retado && probRetado >= probRetador);
    if (!ganEsFuerte) return 'upset';
    const probGan = ganador === retador ? probRetador : probRetado;
    return probGan > 0.65 ? 'victoria_esperada' : 'victoria_ajustada';
}

function aplicarPlaceholders(texto, d) {
    return texto
        .replace(/\{retador\}/g, d.retador || '')
        .replace(/\{retado\}/g, d.retado || '')
        .replace(/\{ganador\}/g, d.ganador || '')
        .replace(/\{perdedor\}/g, d.perdedor || '')
        .replace(/\{monto\}/g, d.monto || '0');
}

async function ejecutarTimeoutDuelos() {
    try {
        const ahoraISO = new Date().toISOString();
        const { data, error } = await supabase
            .from('usuarios')
            .select('username, evento_duelo_retador, evento_duelo_retado, evento_duelo_pcf_retador, evento_duelo_canal')
            .eq('evento_duelo_estado', 'pendiente')
            .lt('evento_duelo_expira', ahoraISO);
        if (error || !data) return;
        const procesados = new Set();
        for (const row of data) {
            const retador = row.evento_duelo_retador;
            const retado = row.evento_duelo_retado;
            const canal = row.evento_duelo_canal;
            const pcfRet = row.evento_duelo_pcf_retador;
            if (!retador || !retado) continue;
            const claveDuelo = retador < retado ? (retador + '|' + retado) : (retado + '|' + retador);
            if (procesados.has(claveDuelo)) continue;
            procesados.add(claveDuelo);
            await limpiarEventoDuelo(retador);
            if (retado && retado !== retador) await limpiarEventoDuelo(retado);
            const rU = await getUsuario(retador);
            const eU = retado ? await getUsuario(retado) : null;
            await crearDuelo({
                retador, retado: retado || '', estado: 'expirado',
                pcf_retador: pcfRet || null, pcf_retado: null, prob_retador: null,
                ganador: null, monto: 0,
                delta_retador: rU ? (rU.recompensa_delta || 0) : 0,
                delta_retado: eU ? (eU.recompensa_delta || 0) : 0,
                canal
            });
            if (rU) {
                const t = await getTextoDuelo('expiracion');
                await notificar(retador, rU.twitch_user_id, '⌛ ' + aplicarPlaceholders(t, { retador, retado: retado || '', monto: '0' }));
            }
        }
    } catch (err) { console.error('❌ Error timeout duelos:', err); }
}

// ============================================
// LURK
// ============================================
function canalTieneLurk(canal) {
    return CANALES_CON_LURK.includes(canal.toLowerCase());
}

async function lurkJoin(username, canal) {
    if (!(await usuarioExiste(username))) return;
    const c = await getCanal(canal);
    if (!c || !c.bot_activo) return;
    if (!(await canalEstaActivo(canal, c))) return;

    // Si alguien entra al chat y el canal está en vivo, el streamer también está en vivo.
    // Le abrimos el bloque al streamer si no lo tenía abierto todavía.
    if (username !== canal) {
        const streamerV2 = await getLurkV2(canal);
        if (streamerV2 && !streamerV2.completo && !streamerV2.join_actual) {
            await inicializarDiaLurkV2(canal);
            await updateLurkV2(canal, { join_actual: new Date().toISOString() });
            console.log('📺 Canal EN VIVO: ' + canal);
            console.log('👁️ JOIN (bloque abierto): ' + canal);
        }
    }

    await inicializarDiaLurkV2(username);
    const v2 = await getLurkV2(username);
    if (!v2) return;
    if (v2.completo) return;
    if (v2.join_actual) {
        if (v2.canal_actual === canal) return;
        const desde = Date.now() - new Date(v2.join_actual).getTime();
        if (desde < LURK_MICRO_COOLDOWN_MS) {
            return;
        }
        await lurkCerrarBloque(username);
    }
    await updateLurkV2(username, { join_actual: new Date().toISOString(), canal_actual: canal });
}

async function lurkPart(username, canal) {
    const v2 = await getLurkV2(username);
    if (!v2 || !v2.join_actual) return;
    // Solo cerrar si el usuario se va del canal donde estaba abierto el bloque
    if (v2.canal_actual !== canal) return;
    if (v2.completo) {
        await updateLurkV2(username, { join_actual: null, canal_actual: null });
        return;
    }
    await lurkCerrarBloque(username);
}
async function rachaSeMantiene(ultimoDiaRacha, hoy) {
    if (!ultimoDiaRacha) return false;
    if (ultimoDiaRacha === hoy) return true;
    // Leer días con stream
    const { data: ds } = await supabase.from('bot_config')
        .select('valor').eq('clave', 'dias_con_stream').maybeSingle();
    let dias = [];
    if (ds && ds.valor) { try { dias = JSON.parse(ds.valor); } catch (e) { dias = []; } }
    // Si no hay info de días con stream, asumimos que sí (no romper racha)
    if (dias.length === 0) return true;
    // ¿Hubo algún día con stream entre ultimoDiaRacha (exclusive) y hoy (exclusive)?
    const enMedio = dias.filter(d => d > ultimoDiaRacha && d < hoy);
    return enMedio.length === 0;
}
async function lurkCerrarBloque(username) {
    const v2 = await getLurkV2(username);
    if (!v2 || !v2.join_actual) return;
    if (v2.completo) {
        await updateLurkV2(username, { join_actual: null });
        return;
    }
    const user = await getUsuario(username);
    if (!user) return;

    const inicio = new Date(v2.join_actual).getTime();
    const minutosBloque = Math.max(0, Math.floor((Date.now() - inicio) / 60000));
    const totalAntes = v2.minutos_hoy || 0;
    const totalDespues = totalAntes + minutosBloque;

    const postasAntes = v2.postas_hoy || 0;
    const postasNuevas = Math.min(3, calcularPostasPorMinutos(totalDespues));

    let puntosNuevos = 0;
    if (postasNuevas > postasAntes) {
        puntosNuevos += calcularPuntosPostas(postasAntes, postasNuevas);
    }

    // Racha: solo al llegar a 3 postas por primera vez hoy
    let rachaNueva = null;
    let ultimoDiaRacha = null;
    if (postasNuevas >= 3 && postasAntes < 3) {
        const reg = await getLurkReg(username);
        if (reg) {
            const hoy = getFechaHoy();
            let racha = reg.racha || 0;
            const mantieneRacha = await rachaSeMantiene(reg.ultimo_dia_racha, hoy);
            if (!mantieneRacha) racha = 0;
            racha += 1;
            const bonusRacha = calcularBonusRacha(racha);
            puntosNuevos += bonusRacha;
            rachaNueva = racha;
            ultimoDiaRacha = hoy;
        }
    }

    // Acreditar puntos (escribe en lurkreg.diaX + lurkv2.puntos_hoy)
    if (puntosNuevos !== 0) {
        await agregarPuntosObservacionNueva(username, puntosNuevos);
    }

    // Avist pendiente: si llegó a ≥1 posta, acreditar
    if (postasNuevas >= 1 && v2.avist_pendiente > 0) {
        await agregarPuntosObservacionNueva(username, v2.avist_pendiente);
        await updateLurkV2(username, { avist_pendiente: 0 });
    }

    // Actualizar lurkv2
    const updateV2 = {
        minutos_hoy: totalDespues,
        postas_hoy: postasNuevas,
        join_actual: null,
        canal_actual: null,
        ultimo_chequeo: new Date().toISOString()
    };
    if (postasNuevas >= 3) updateV2.completo = true;
    await updateLurkV2(username, updateV2);

    // Actualizar racha en lurkreg
    if (rachaNueva !== null) {
        await updateLurkReg(username, { racha: rachaNueva, ultimo_dia_racha: ultimoDiaRacha });
    }

    // Minutos totales (para !infoop)
    if (minutosBloque > 0) {
        await updateUsuario(username, { minutos_lurk: (user.minutos_lurk || 0) + minutosBloque });
    }

    if (puntosNuevos !== 0) {
        const userPost = await getUsuario(username);
        if (userPost) chequearHakiCambio('observacion', user.observacion || 0, userPost.observacion);
    }

    console.log('📊 Lurk cerrado: ' + username + ' → ' + totalDespues + ' min, ' + postasNuevas + ' postas, +' + puntosNuevos + ' pts');

    // Notificación de rango
    const userFresh = await getUsuario(username);
    if (userFresh) {
        const supObs = await esSupremoObservacion(username);
        const rangoActual = getRangoObservacion(userFresh.observacion || 0, supObs);
        const reg = await getLurkReg(username);
        const rangoNotif = reg ? (reg.rango_notificado === null || reg.rango_notificado === undefined ? -1 : reg.rango_notificado) : -1;
        if (rangoActual.idx === 0 && rangoNotif < 0 && (userFresh.observacion || 0) >= 1) {
            await notificar(username, userFresh.twitch_user_id, MENSAJES_RANGO_OBS[1]);
            await updateLurkReg(username, { rango_notificado: 0 });
        } else if (rangoActual.idx >= 1 && rangoActual.idx > rangoNotif) {
            console.log('⬆️ Rango: ' + username + ' → Observación ' + rangoActual.nombre);
            const msg = MENSAJES_RANGO_OBS[rangoActual.idx + 1];
            if (msg) await notificar(username, userFresh.twitch_user_id, msg);
            await updateLurkReg(username, { rango_notificado: rangoActual.idx });
        }
    }
}

async function inicializarDiaLurkV2(username) {
    const v2 = await getLurkV2(username);
    if (!v2) return null;
    const hoy = getFechaHoy();
    if (v2.ultimo_dia === hoy) return v2;
    await updateLurkV2(username, {
        minutos_hoy: 0,
        postas_hoy: 0,
        puntos_hoy: 0,
        completo: false,
        avist_reclamado: false,
        avist_pendiente: 0,
        join_actual: null,
        ultimo_dia: hoy
    });
    return await getLurkV2(username);
}

// Cache de live por canal (5 min TTL)
const liveCache = {};
const LIVE_CACHE_TTL = 5 * 60 * 1000;
// Estado de "última vez que vi live por scan" para evitar spam de logs
const canalesEstadoScan = {};

async function canalEstaActivo(canal, canalDb) {
    const c = canalDb !== undefined ? canalDb : await getCanal(canal);
    if (!c) return true; // Canal desconocido → no bloqueamos
    if (!c.lurk_activo) return true; // Canal sin lurk → siempre activo
    // Canal con lurk → chequear live con cache
    const ahora = Date.now();
    if (liveCache[canal] && ahora - liveCache[canal].timestamp < LIVE_CACHE_TTL) {
        return liveCache[canal].live;
    }
    const live = await checkLiveHelix(canal);
    liveCache[canal] = { live, timestamp: ahora };
    return live;
}

async function checkLiveHelix(canal) {
    try {
        const url = TWITCH_API_URL + '/streams?user_login=' + canal;
        const res = await fetch(url, {
            headers: {
                'Client-ID': config.clientId,
                'Authorization': 'Bearer ' + config.oauth.replace('oauth:', '')
            }
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data.data && data.data.length > 0;
    } catch (e) { console.error('Error live check:', e); return false; }
}
// ============================================
// SCAN DE CHATTERS
// ============================================
const broadcasterIdsCache = {};
const BROADCASTER_CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function obtenerBroadcasterId(canal) {
    const cached = broadcasterIdsCache[canal];
    if (cached && Date.now() - cached.timestamp < BROADCASTER_CACHE_TTL) {
        return cached.id;
    }
    try {
        const url = TWITCH_API_URL + '/users?login=' + canal;
        const res = await fetch(url, {
            headers: {
                'Client-ID': config.clientId,
                'Authorization': 'Bearer ' + config.oauth.replace('oauth:', '')
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const id = (data.data && data.data[0]) ? data.data[0].id : null;
        if (id) broadcasterIdsCache[canal] = { id, timestamp: Date.now() };
        return id;
    } catch (e) {
        console.error('❌ Error obtenerBroadcasterId:', e);
        return null;
    }
}

async function escanearChatters(canal) {
    try {
        if (!canalTieneLurk(canal)) return;
        const c = await getCanal(canal);
        if (!c || !c.bot_activo) return;

        // 1. ¿Está live el canal?
        const live = await checkLiveHelix(canal);
        if (!live) {
            if (canalesEstadoScan[canal] === true) {
                console.log('📺 Canal OFFLINE: ' + canal);
            }
            canalesEstadoScan[canal] = false;
            // Buscar SOLO los bloques abiertos en ESTE canal
            const { data: abiertos } = await supabase.from('lurkv2')
                .select('usuario').eq('canal_actual', canal).not('join_actual', 'is', null);
            if (abiertos && abiertos.length > 0) {
                for (const a of abiertos) {
                    await lurkCerrarBloque(a.usuario);
                }
                console.log('👁️ Scan ' + canal + ': canal offline, ' + abiertos.length + ' bloques cerrados');
            }
            return;
        }

        // 2. Canal live → pedir broadcaster ID y listar chatters
        const broadcasterId = await obtenerBroadcasterId(canal);
        if (!broadcasterId) {
            console.error('❌ No se pudo obtener broadcasterId de ' + canal);
            return;
        }
        const url = TWITCH_API_URL + '/chat/chatters?broadcaster_id=' + broadcasterId +
            '&moderator_id=' + config.botUserId + '&first=1000';
        const res = await fetch(url, {
            headers: {
                'Client-ID': config.clientId,
                'Authorization': 'Bearer ' + config.oauth.replace('oauth:', '')
            }
        });
        if (!res.ok) {
            console.error('❌ Error scan chatters (' + res.status + '):', await res.text());
            return;
        }
        const data = await res.json();
        const chatters = data.data || [];
        canalesEstadoScan[canal] = true; // Marcar como online (próximo OFFLINE sí va a loguear)

        // 3. Usuarios registrados (todos los que interactuaron con el bot alguna vez)
        const { data: usuariosDb } = await supabase.from('usuarios').select('username');
        const usuariosSet = new Set((usuariosDb || []).map(u => u.username.toLowerCase()));

        // 4. Registrados que están en el chat
        const enChat = new Set();
        for (const ch of chatters) {
            const u = ch.user_login.toLowerCase();
            if (usuariosSet.has(u)) enChat.add(u);
        }

        // 5. Reabrir bloques de los que están en el chat (omitiendo completos)
        for (const username of enChat) {
            const v2 = await getLurkV2(username);
            if (!v2) continue;
            if (v2.completo) continue;
            // Si ya está abierto en este canal, solo renovar heartbeat
            if (v2.join_actual && v2.canal_actual === canal) {
                await updateLurkV2(username, { ultimo_chequeo: new Date().toISOString() });
                continue;
            }
            // Si estaba en otro canal, cerrar ese bloque primero
            if (v2.join_actual) await lurkCerrarBloque(username);
            await inicializarDiaLurkV2(username);
            const v2Fresh = await getLurkV2(username);
            if (v2Fresh && !v2Fresh.completo) {
                await updateLurkV2(username, { join_actual: new Date().toISOString(), canal_actual: canal, ultimo_chequeo: new Date().toISOString() });
            }
        }

        // 6. Cerrar bloques de registrados que ya NO están en el chat
        const { data: conBloque } = await supabase.from('lurkv2')
            .select('usuario, canal_actual, ultimo_chequeo').not('join_actual', 'is', null);
        if (conBloque) {
            for (const row of conBloque) {
                if (enChat.has(row.usuario) || !usuariosSet.has(row.usuario)) continue;
                if (row.canal_actual !== canal) continue; // proteger streamer (null) y otros canales
                if (!row.ultimo_chequeo) continue;
                const minSinVer = (Date.now() - new Date(row.ultimo_chequeo).getTime()) / 60000;
                if (minSinVer > 20) {
                    await lurkCerrarBloque(row.usuario);
                }
            }
        }
    } catch (err) {
        console.error('❌ Error escanearChatters:', err);
    }
}

function msHastaProximoScan() {
    const ahora = new Date();
    const utcMs = ahora.getTime();
    const arMs = utcMs - (3 * 60 * 60 * 1000);
    const arg = new Date(arMs);
    const minutosTotales = arg.getUTCHours() * 60 + arg.getUTCMinutes() + arg.getUTCSeconds() / 60;
    let proximo = null;
    for (let h = 0; h < 24 && proximo === null; h++) {
        for (const m of [1, 21, 41]) {
            const t = h * 60 + m;
            if (t > minutosTotales) { proximo = t; break; }
        }
    }
    if (proximo === null) proximo = 24 * 60 + 1;
    return (proximo - minutosTotales) * 60000;
}

async function programarProximoScan() {
    const ms = msHastaProximoScan();
    setTimeout(async () => {
        for (const canal of CANALES_CON_LURK) {
            try { await escanearChatters(canal); }
            catch (e) { console.error('Error scan ' + canal + ':', e); }
        }
        programarProximoScan();
    }, ms);
}
async function cerrarDiaObservacion(fechaAnterior) {
    // Verificar si el día anterior tuvo stream (según bot_config.dias_con_stream)
    const { data: ds } = await supabase.from('bot_config')
        .select('valor').eq('clave', 'dias_con_stream').maybeSingle();
    let dias = [];
    if (ds && ds.valor) {
        try { dias = JSON.parse(ds.valor); } catch (e) { dias = []; }
    }
    if (!dias.includes(fechaAnterior)) {
        console.log('📅 Cierre ' + fechaAnterior + ': sin stream, vigencia no avanza');
        return;
    }
    // Avanzar vigencia para todos los usuarios de lurkreg
    const { data: usuarios } = await supabase.from('lurkreg').select('usuario');
    if (!usuarios || usuarios.length === 0) return;
    for (const u of usuarios) {
        await avanzarVigencia(u.usuario);
    }
    console.log('📅 Cierre ' + fechaAnterior + ': vigencia avanzada para ' + usuarios.length + ' usuarios');
}

async function lurkChequeoPeriodico() {
    try {
        const hoy = getFechaHoy();
        const ayer = getFechaOffset(-1);

        // 1. Cerrar bloques y resetear a TODOS los que quedaron en el día anterior
        const { data: desfasados } = await supabase.from('lurkv2')
            .select('usuario, join_actual, ultimo_dia')
            .neq('ultimo_dia', hoy);
        if (desfasados) {
            for (const a of desfasados) {
                if (a.join_actual) {
                    await lurkCerrarBloque(a.usuario); // Esto ya limpia canal_actual
                }
                await inicializarDiaLurkV2(a.usuario);
            }
            // Forzar un scan inmediato para reabrir bloques del nuevo día en canales live
            for (const canal of CANALES_CON_LURK) {
                try { await escanearChatters(canal); }
                catch (e) { console.error('Error scan post-cierre ' + canal + ':', e); }
            }
        }

        // 2. Cierre del día anterior (una sola vez por día)
        const { data: flag } = await supabase.from('bot_config')
            .select('valor').eq('clave', 'cierre_dia_ultimo').maybeSingle();
        if (!flag || flag.valor !== ayer) {
            await cerrarDiaObservacion(ayer);
            await supabase.from('bot_config').upsert({ clave: 'cierre_dia_ultimo', valor: ayer });
        }

        // 3. Actualizar live_minutos de canales
        const canales = await getCanales();
        let huboStreamHoy = false;
        for (const c of canales) {
            if (!c.bot_activo) continue;
            const live = await checkLiveHelix(c.canal);
            if (!live) continue;
            huboStreamHoy = true;
            let liveMin = c.live_minutos_hoy || 0;
            if (c.ultimo_dia_live !== hoy) liveMin = 0;
            liveMin += 10;
            const updateC = { live_minutos_hoy: liveMin, ultimo_dia_live: hoy };
            if (liveMin >= LURK_LIVE_MINIMO_2H && c.dia_contado_2h !== hoy) {
                updateC.dia_contado_2h = hoy;
                console.log('📺 Día con stream contado: ' + c.canal + ' → ' + hoy);
            }
            await updateCanal(c.canal, updateC);
        }

        // 4. Registrar el día en el historial de días con stream
        if (huboStreamHoy) {
            const { data: ds } = await supabase.from('bot_config')
                .select('valor').eq('clave', 'dias_con_stream').maybeSingle();
            let dias = [];
            if (ds && ds.valor) {
                try { dias = JSON.parse(ds.valor); } catch (e) { dias = []; }
            }
            if (!dias.includes(hoy)) {
                dias.push(hoy);
                // Recortar a los últimos 30 días
                dias.sort();
                if (dias.length > 30) dias = dias.slice(-30);
                await supabase.from('bot_config').upsert({ clave: 'dias_con_stream', valor: JSON.stringify(dias) });
            }
        }
    } catch (err) { console.error('❌ Error lurk chequeo:', err); }
}

// ============================================
// NPC EVENT
// ============================================
let npcCicloActual = null;
let npcActual = null;
let npcUsadosCiclo = [];
let npcUltimoAnuncio = null;
let npcVentanaHasta = null;

async function cargarEstadoNpc() {
    const ciclo = getFechaNpc();
    const { data } = await supabase.from('npc_evento').select('*').eq('fecha_ciclo', ciclo).maybeSingle();
    if (data) {
        npcCicloActual = ciclo;
        npcActual = data.npc_actual;
        npcUsadosCiclo = data.npcs_usados || [];
        npcUltimoAnuncio = data.ultimo_anuncio;
        npcVentanaHasta = data.ventana_hasta;
    } else {
        npcCicloActual = ciclo;
        npcActual = null;
        npcUsadosCiclo = [];
        npcUltimoAnuncio = null;
        npcVentanaHasta = null;
        await supabase.from('npc_evento').upsert([{
            fecha_ciclo: ciclo, npc_actual: null, npcs_usados: [],
            ultimo_anuncio: null, ventana_hasta: null
        }], { onConflict: 'fecha_ciclo' });
    }
}

async function guardarEstadoNpc() {
    if (!npcCicloActual) return;
    await supabase.from('npc_evento').upsert([{
        fecha_ciclo: npcCicloActual,
        npc_actual: npcActual,
        npcs_usados: npcUsadosCiclo,
        ultimo_anuncio: npcUltimoAnuncio,
        ventana_hasta: npcVentanaHasta
    }], { onConflict: 'fecha_ciclo' });
}

async function anunciarNpc() {
    if (npcUltimoAnuncio) {
        const desdeUlt = Date.now() - new Date(npcUltimoAnuncio).getTime();
        if (desdeUlt < 55 * 60 * 1000) return;
    }
    // Verificar si hay al menos un canal live antes de anunciar
    const canalesCheck = await getCanales();
    let hayAlgunLive = false;
    for (const c of canalesCheck) {
        if (c.bot_activo && await checkLiveHelix(c.canal)) { hayAlgunLive = true; break; }
    }
    if (!hayAlgunLive) return; // Nadie en vivo, no anunciar ni gastar NPC

    const { data: todos } = await supabase.from('npcs').select('nombre');
    if (!todos || todos.length === 0) return;
    const disponibles = todos.filter(n =>
        !npcUsadosCiclo.includes(n.nombre) && !NPCS_EXCLUIDOS_AVISTAMIENTO.includes(n.nombre)
    );
    if (disponibles.length === 0) return;
    const elegido = disponibles[Math.floor(Math.random() * disponibles.length)];
    npcActual = elegido.nombre;
    npcUsadosCiclo.push(npcActual);
    npcUltimoAnuncio = new Date().toISOString();
    npcVentanaHasta = new Date(Date.now() + NPC_VENTANA_MINUTOS * 60000).toISOString();
    await guardarEstadoNpc();
    const canales = await getCanales();
    const msg = '👁️ ¡' + npcActual + ' apareció! Susurrá "!personaje ' + npcActual.toLowerCase() + '" (tenés ' + NPC_VENTANA_MINUTOS + ' min) 👁️';
    for (const c of canales) {
        if (!c.bot_activo) continue;
        const live = await checkLiveHelix(c.canal);
        if (!live) continue;
        try { client.say(c.canal, msg); } catch (e) { console.error('Error NPC msg:', e); }
    }
    console.log('👁️ NPC anunciado: ' + npcActual);
}

function msHastaProximoMedia() {
    const ahora = new Date();
    const utcMs = ahora.getTime();
    const arMs = utcMs - (3 * 60 * 60 * 1000);
    const arDate = new Date(arMs);
    const minutos = arDate.getUTCMinutes();
    const segundos = arDate.getUTCSeconds();
    let minsFaltantes;
    if (minutos < 30) minsFaltantes = 30 - minutos;
    else minsFaltantes = 60 - minutos + 30;
    return minsFaltantes * 60000 - segundos * 1000;
}

async function programarProximoNpc() {
    const ms = msHastaProximoMedia();
    console.log('👁️ Próximo anuncio NPC en ' + Math.round(ms / 60000) + ' min');
    setTimeout(async () => {
        try { await anunciarNpc(); }
        catch (e) { console.error('Error NPC:', e); }
        programarProximoNpc();
    }, ms);
}

async function procesarPersonaje(username, nombreIngresado, fromUserId) {
    if (!npcActual) { await sendWhisper(fromUserId, '⏳ No hay ningún avistamiento activo ahora.'); return; }
    if (!npcVentanaHasta || new Date(npcVentanaHasta) < new Date()) {
        await sendWhisper(fromUserId, '⏳ Ya pasó la ventana de reclamo.'); return;
    }
    const v2 = await getLurkV2(username);
    if (!v2) return;
    if (v2.avist_reclamado) {
        await sendWhisper(fromUserId, 'Ya reclamaste tu avistamiento de hoy. Volvé mañana.'); return;
    }
    const ingresado = nombreIngresado.toLowerCase().trim();
    const correcto = npcActual.toLowerCase().trim();
    if (ingresado === correcto) {
        await updateLurkV2(username, { avist_reclamado: true });
        if ((v2.postas_hoy || 0) >= 1) {
            const userAntes = await getUsuario(username);
            const obsAntes = (userAntes && userAntes.observacion) || 0;
            await agregarPuntosObservacionNueva(username, 2);
            const userPost = await getUsuario(username);
            if (userPost) chequearHakiCambio('observacion', obsAntes, userPost.observacion);
            await sendWhisper(fromUserId, '👁️ ¡Bien visto! +2 de Haki de Observación para vos.');
        } else {
            await updateLurkV2(username, { avist_pendiente: 2 });
            await sendWhisper(fromUserId, '👁️ ¡Acertaste! Aunque... hace falta que estés al menos 10 min en el stream. Cuando llegues, te sumo los puntos.');
        }
    } else {
        await sendWhisper(fromUserId, '❌ Ese no era, locura.');
    }
}
// ============================================
// AYUDA
// ============================================
const AYUDA_MENU = '📖 AYUDA op_d_bot — 💬 !ayudachat → Comandos de chat — 📩 !ayudasusurro → Comandos de susurro — 🔍 !ayuda <tema> → Detalle de un tema. Temas: observacion, armadura, conquistador, explorar, fruta, duelos, infoop, rangos, recompensas, coliseo';

const AYUDA_TEMAS = {
    observacion: '📡 HAKI DE OBSERVACIÓN\n' +
        'Se entrena estando presente en el chat del stream.\n' +
        '• Hitos de tiempo: 10 min (1ra posta), 30 min (2da posta) y 60 min (3ra posta).\n' +
        '• Al llegar a cada posta ganás puntos automáticamente (1, 1 y 2 puntos).\n' +
        '• Si acertás el avistamiento NPC del stream, ganás +2 puntos extra.\n' +
        '• Completar las 3 postas mantiene tu racha y te da un bonus.\n' +
        '⚠️ IMPORTANTE: Twitch deja de registrar tu presencia en el chat si pasás 20 minutos sin escribir. Aunque estés viendo el stream, no se te cuentan los minutos. Para que el bot te cuente, escribí algo cada tanto.\n' +
        '• Mirá tu progreso con !observacion y los canales activos con !canaleson.',
    armadura: '🛡️ HAKI DE ARMADURA\n' +
        'Se entrena con !op (máx 3 veces por día, cooldown 10 min).\n' +
        '• Cada !op hace una tirada según tu rango (puede sumar o restar).\n' +
        '• Completar los 3 !op del día da bonus diario.\n' +
        '• Días seguidos entrenando = bonus por racha.\n' +
        '• Si un día no entrenás, al siguiente perdés puntos.',
    conquistador: '⚜️ HAKI DE CONQUISTADOR\n' +
        'Se entrena explorando y duelando.\n' +
        '• Ganás Conquistador al ganar exploraciones (!explorar → !combatir).\n' +
        '• Se gana/pierde Conquistador en duelos (!retar @usuario).\n' +
        '• Perdés Conquistador si te retirás durante una exploración.',
    explorar: '🗺️ EXPLORACIÓN\n' +
        'Se usa por susurro (!explorar), 1 vez por día.\n' +
        '• Te aparecen 3 caminos con dificultades distintas.\n' +
        '• Elegís uno (!facil / !medio / !dificil).\n' +
        '• Enfrentás a un NPC. Podés !continuar o !retroceder.\n' +
        '• Al combatir ganás/perdés Conquistador y Berries según el resultado.\n' +
        '• Si te retirás en fases posteriores, perdés Conquistador.\n' +
        '• Las recompensas dependen de tu rango de Conquistador: a menor rango, más ganás (para poder subir rápido).',
    fruta: '🍎 FRUTAS DEL DIABLO\n' +
        'Buscás frutas con !fruta (máx 5 intentos por día).\n' +
        '• Si encontrás una, elegís !comer o !rechazar.\n' +
        '• Algunas tienen evento: primero !si/!no, después !pelear/!huir.\n' +
        '• Si tenés un evento pendiente, usá !frutapendiente para retomarlo.\n' +
        '• Solo podés tener 1 fruta a la vez.\n' +
        '• Algunas frutas raras las tienen otros usuarios. ¡Competí por ellas!',
    duelos: '⚔️ DUELOS\n' +
        'Retás a otros con !retar @usuario (chat o susurro).\n' +
        '• El retado tiene 2 min para !aceptarduelo o !rechazarduelo.\n' +
        '• El ganador se lleva Berries del perdedor (según recompensas).\n' +
        '• Máx 10 duelos por día, 3 contra la misma persona.\n' +
        '• El ganador también gana Conquistador (1 a 3 según lo parejo del duelo).',
    infoop: '📊 TU INFO (!infoop)\n' +
        'Muestra: 🍎 fruta | 🛡️ Armadura | 👁️ Observación | ⚜️ Conquistador | 🏴‍☠️💰 recompensa.\n' +
        '• En chat muestra tu info resumida (actualiza tu recompensa pública).\n' +
        '• Por susurro muestra tu info detallada.\n' +
        '• !infoop @usuario muestra info resumida de otro.',
    rangos: '🎖️ RANGOS DE HAKI\n' +
        'Armadura y Observación: No despertado (0) → Despertado (40) → Básico (70) → Avanzado (90) → Supremo (100+).\n' +
        'Conquistador: No despertado (0) → Despertado (60) → Básico (80) → Avanzado (95) → Supremo (100+).\n' +
        'Los Supremos son solo unos pocos.',
    recompensas: '🏴‍☠️💰 RECOMPENSAS\n' +
        'Tu recompensa crece con tus stats y con lo que ganás (o perdés) en eventos.\n' +
        '• En chat: se actualiza tu recompensa pública (la que ven otros).\n' +
        '• Por susurro: ves tu recompensa real siempre actualizada.',
    coliseo: '🏟️ COLISEO\n' +
        'Se abre con !coliseo (solo el streamer del canal o el dueño global pueden abrirlo).\n' +
        '• Ventana de 3 minutos para inscribirte con !coliseo. Máximo 12 participantes.\n' +
        '• Requisito: tener al menos 5 de Conquistador.\n' +
        '• El costo de entrada depende de tu chance de ganar: el favorito paga hasta 5 de Conq + $50M, el underdog paga menos.\n' +
        '• Si son 2, es un 1v1. Si son 3 o más, pelean todos contra todos (Battle Royale).\n' +
        '• El ganador se lleva la mayor parte del pozo. El 2º (si son 5+) también recibe premio.\n' +
        '• Si solo hay 1 inscripto o los rivales no están parejos (<15% chance), el Coliseo se cancela sin cobrar.\n' +
        '• Mientras estás en el Coliseo no podés usar !op, !fruta, !comer, !pelear, !retar, !aceptarduelo ni !explorar.'
};
const AYUDA_CHAT = '💬 COMANDOS DE CHAT 🎮 !op → Entrena Haki 📊 !infoop → Tu info 🍎 !fruta → Busca fruta ⏳ !frutapendiente → Ver pendiente ⚔️ !retar @usuario → Duelo 🏆 !historial @usuario';
const AYUDA_CHAT_STREAMER = '💬 COMANDOS DE CHAT 🎮 !op → Entrena Haki 📊 !infoop → Tu info 🍎 !fruta → Busca fruta ⚔️ !retar @usuario → Duelo 🏆 !historial @usuario 🔴 !offop / 🟢 !onop';
const AYUDA_SUSURRO = '📩 COMANDOS DE SUSURRO (o chat de op_d_bot) 🗺️ !explorar ⏳ !exploracionpendiente ⚔️ !duelopendiente 📊 !infoop 👤 !infoop @usuario 🔄 !actualizacion 📡 !observacion 📡 !canaleson 👁️ !personaje <nombre>';

// ============================================
// CLIENTE
// ============================================
const client = new tmi.Client({
    options: { debug: false },
    identity: { username: config.botName, password: config.oauth },
    channels: [config.channelName, 'op_d_bot', 'lenno_ap', 'pepeecr']
});

// Wrapper: loguea TODAS las respuestas del bot en el chat
const _originalSay = client.say.bind(client);
client.say = (channel, message) => {
    console.log('💬 Bot → ' + channel + ': ' + message.replace(/\n/g, ' | '));
    return _originalSay(channel, message);
};

client.connect()
    .then(() => console.log('Bot conectado como ' + config.botName))
    .catch(err => console.error('Error al conectar:', err));

// ============================================
// JOIN / PART — LURK TRACKING
// ============================================
client.on('join', async (channel, username, self) => {
    if (self) return;
    const canal = channel.replace('#', '').toLowerCase();
    if (!canalTieneLurk(canal)) return;
    try {
        await lurkJoin(username.toLowerCase(), canal);
    } catch (e) { console.error('Error lurk join:', e); }
});

client.on('part', async (channel, username, self) => {
    if (self) return;
    const canal = channel.replace('#', '').toLowerCase();
    if (!canalTieneLurk(canal)) return;
    try {
        await lurkPart(username.toLowerCase(), canal);
    } catch (e) { console.error('Error lurk part:', e); }
});

// ============================================
// SUSURROS IRC
// ============================================
client.on('whisper', async (from, userstate, message, self) => {
    if (self) return;
    const fromUser = from.startsWith('#') ? from.slice(1) : from;
    const twitchUserId = userstate['user-id'];
    console.log('📩 [SUSURRO] de ' + fromUser + ': ' + message);
    try {
        if (twitchUserId) {
            const u = await getUsuario(fromUser.toLowerCase());
            if (u) {
                const updates = {};
                if (u.twitch_user_id !== twitchUserId) updates.twitch_user_id = twitchUserId;
                if (!u.ha_susurrado) updates.ha_susurrado = true;
                if (Object.keys(updates).length > 0) {
                    await updateUsuario(fromUser.toLowerCase(), updates);
                }
            }
        }
        const fakeEvent = {
            from_user_id: twitchUserId,
            from_user_login: fromUser,
            whisper: { text: message }
        };
        await handleWhisper(fakeEvent);
    } catch (err) { console.error('❌ Error whisper:', err); }
});

// ============================================
// ENVIAR NOTIFICACIÓN (solo si ya susurró antes)
// ============================================
async function notificar(username, toUserId, message) {
    if (!toUserId) return;
    try {
        const u = await getUsuario(username);
        if (!u || !u.ha_susurrado) return;
        await sendWhisper(toUserId, message);
    } catch (e) { console.error('Error notificar:', e); }
}

// ============================================
// ENVIAR SUSURRO
// ============================================
async function sendWhisper(toUserId, message, forzarSusurro) {
    const ctx = contextoOpDBot.getStore();
    if (!forzarSusurro && ctx && ctx.fromUserId === toUserId) {
        client.say('op_d_bot', '@' + ctx.username + ' ' + message);
        return true;
    }
    const url = TWITCH_API_URL + '/whispers?from_user_id=' + config.botUserId + '&to_user_id=' + toUserId;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Client-ID': config.clientId,
                'Authorization': 'Bearer ' + config.oauth.replace('oauth:', ''),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message })
        });
        if (response.status === 204) {
            console.log('✅ Susurro → ' + toUserId + ': ' + message.replace(/\n/g, ' | '));
            return true;
        } else {
            console.error('❌ Error susurro: ' + response.status, await response.text());
            return false;
        }
    } catch (err) {
        console.error('❌ Error red susurro:', err);
        return false;
    }
}
// ============================================
// !SUSURRAME — test de susurro
// ============================================
async function procesarSusurrame(username, twitchUserId, channel) {
    if (!twitchUserId) {
        client.say(channel, '@' + username + ' ❌ No puedo identificarte en Twitch.');
        return;
    }
    const user = await getUsuario(username);
    if (!user) {
        client.say(channel, '@' + username + ' ❌ Error al obtener tus datos.');
        return;
    }
    const antes = user.ha_susurrado;
    if (!antes) {
        await updateUsuario(username, { ha_susurrado: true });
    }
    const mensaje = '✅ ¡Funciona! Comandos que podés usar por susurro:\n' + AYUDA_SUSURRO;
    const ok = await sendWhisper(twitchUserId, mensaje, true);
    if (!ok) {
        // Revertir el flag si lo habíamos cambiado
        if (!antes) {
            await updateUsuario(username, { ha_susurrado: false });
        }
        client.say(channel, '@' + username + ' ❌ No puedo mandarte susurros. Tu configuración de Twitch no lo permite.');
    }
    // Si ok, no avisamos nada en el chat: el usuario ya recibió el susurro
}
// ============================================
// !FRUTA — busca fruta (chat o susurro)
// ============================================
async function procesarFruta(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    try {
        const user = await getUsuario(username);
        if (!user) return;
        const tieneYami = (user.fruta === 'Yami Yami no Mi' || user.fruta_2 === 'Yami Yami no Mi');
        const yaTieneDos = user.fruta && user.fruta_2;
        if (yaTieneDos) {
            await responder('@' + displayName + ' 😤 PARAAAAA LOCO, ¿cuántas frutas querés? Ya tenés 2, dejá alguna para los demás piratas.');
            return;
        }
        if (user.fruta && !tieneYami) {
            // Mostrar info de la fruta equipada
            const { data: fEq } = await supabase.from('frutas').select('descripcion, emoji, ataque, defensa, utilidad').eq('nombre', user.fruta).single();
            if (fEq) {
                const desc = (fEq.descripcion || '').replace(/\n/g, ' ').trim();
                await responder('@' + displayName + ' Ya tenés la ' + user.fruta + ' ' + (fEq.emoji || '') + '. ' + desc + ' ⚔️ ' + displayStat(fEq.ataque || 0) + ' | 🛡️ ' + displayStat(fEq.defensa || 0) + ' | 🧠 ' + displayStat(fEq.utilidad || 0));
            } else {
                await responder('@' + displayName + ' Ya tenés fruta.');
            }
            return;
        }
        if (user.fruta_pendiente && !user.fruta_pendiente.startsWith('meme:')) {
            // Mostrar info de la fruta pendiente
            const { data: fPend } = await supabase.from('frutas').select('descripcion, emoji, ataque, defensa, utilidad').eq('nombre', user.fruta_pendiente).single();
            if (fPend) {
                const desc = (fPend.descripcion || '').replace(/\n/g, ' ').trim();
                await responder('[Pendiente] @' + displayName + ' Tenés pendiente la ' + user.fruta_pendiente + ' ' + (fPend.emoji || '') + '. ' + desc + ' ⚔️ ' + displayStat(fPend.ataque || 0) + ' | 🛡️ ' + displayStat(fPend.defensa || 0) + ' | 🧠 ' + displayStat(fPend.utilidad || 0) + ' — !comer o !rechazar');
            } else {
                await responder('[Pendiente] @' + displayName + ' Tenés una fruta pendiente. Usá !comer, !rechazar o !frutapendiente para verla.');
            }
            return;
        }
        if (user.evento_fruta_estado === 'pendiente') {
            if (user.evento_fruta_comida_por_otro) {
                await responder('[Pendiente] @' + displayName + ' La fruta de tu evento ya fue consumida.');
                return;
            }
            const { data: frutaEv } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
            if (frutaEv) {
                const filtroEv = canalDb ? canalDb.episodio_filtro : null;
                if (!pasaFiltroEpisodio(frutaEv, filtroEv)) {
                    await responder('[Pendiente] @' + displayName + ' Tenés un evento de fruta pendiente, pero todavía no se vio en este canal. Podés continuar en el chat de op_d_bot.');
                    return;
                }
                if (user.evento_fruta_fase === 'avistamiento') {
                    await responder('[Pendiente] @' + displayName + ' ' + frutaEv.fase1 + ' — ✅ !si o ❌ !no');
                } else {
                    const calaverasEv = await getCalaverasEventoFruta(user, frutaEv);
                    await responder('[Pendiente] @' + displayName + ' ' + calaverasEv + ' ' + frutaEv.fase2 + ' 🍎 ' + frutaEv.nombre + ' ' + (frutaEv.emoji || '') + ' ⚔️ ' + displayStat(frutaEv.ataque || 0) + ' | 🛡️ ' + displayStat(frutaEv.defensa || 0) + ' | 🧠 ' + displayStat(frutaEv.utilidad || 0) + ' ¿Qué harás? — ⚔️ !pelear o 🏃 !huir');
                }
            } else {
                await responder('[Pendiente] @' + displayName + ' Tenés un evento de fruta pendiente.');
            }
            return;
        }
        // Yami Yami: descubrimiento épico (solo primera vez)
        if (tieneYami && !user.fruta_2 && !user.yami_aviso_mostrado) {
            await updateUsuario(username, { yami_aviso_mostrado: true });
            await responder('@' + displayName + ' 🌑⚡ ¡ANOMALÍA! La Yami Yami no Mi pulsa con fuerza. Las tinieblas se retuercen dentro tuyo... y una puerta se abre. ¡Podés contener una SEGUNDA fruta del diablo! Los mares temblarán con tu nombre.');
        }
        // ¿Tiene premio consuelo pendiente? Si sí, esta tirada es extra: no cuenta para el límite diario ni consume cooldown.
        const tienePremioConsuelo = !!user.fruta_perdida_pcf;

        // Reset diario de intentos
        const hoy = getFechaHoy();
        let intentosHoy = user.fruta_intentos_hoy || 0;
        if (user.ultimo_dia_fruta !== hoy) {
            intentosHoy = 0;
            await updateUsuario(username, { fruta_intentos_hoy: 0, ultimo_dia_fruta: hoy });
        }
        if (!tienePremioConsuelo && intentosHoy >= FRUTA_LIMITE_DIARIO) {
            await responder('@' + displayName + ' Ya usaste tus 5 intentos de hoy. Volvé mañana.');
            return;
        }
        if (!tienePremioConsuelo) {
            const ahora = Date.now();
            const ultimoUso = cooldowns['fruta_' + username] || 0;
            const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
            if (tiempoRestante > 0) {
                const min = Math.floor(tiempoRestante / 60000);
                const seg = Math.floor((tiempoRestante % 60000) / 1000);
                const tiempoTxt = min > 0 ? (min + 'm ' + seg + 's') : (seg + 's');
                await responder('@' + displayName + ' Esperá ' + tiempoTxt + '.');
                return;
            }
            cooldowns['fruta_' + username] = Date.now();
            await updateUsuario(username, { fruta_intentos_hoy: intentosHoy + 1, ultimo_dia_fruta: hoy });
        }
        // Traer solo frutas con disponible = true (excluye las que ya comió alguien)
        const { data: frutasDisponibles, error: errFrutas } = await supabase.from('frutas').select('*').eq('disponible', true);
        if (errFrutas || !frutasDisponibles || !frutasDisponibles.length) {
            await responder('@' + displayName + ' No hay frutas disponibles.'); return;
        }
        // Filtrar por episodio del canal
        const filtroEp = canalDb ? canalDb.episodio_filtro : null;
        const frutasFiltradas = frutasDisponibles.filter(f => pasaFiltroEpisodio(f, filtroEp));
        if (frutasFiltradas.length === 0) {
            await responder('@' + displayName + ' No hay frutas disponibles para este canal.'); return;
        }
        let selectedFruit = null;
        if (tienePremioConsuelo) {
            // Premio consuelo: elegir la fruta con PCF más cercano al perdido. Sin sortear, sin gastar intento.
            const pcfObjetivo = user.fruta_perdida_pcf || 0;
            let mejorDistancia = Infinity;
            for (const f of frutasFiltradas) {
                const dist = Math.abs((f.poder_fruta || 0) - pcfObjetivo);
                if (dist < mejorDistancia) {
                    mejorDistancia = dist;
                    selectedFruit = f;
                }
            }
            if (selectedFruit) {
                await updateUsuario(username, { fruta_perdida_pcf: null });
                console.log('🍎 Premio consuelo: ' + username + ' → ' + selectedFruit.nombre + ' (PCF objetivo ' + pcfObjetivo + ')');
            }
        } else {
            // Sistema de puertas: sortear si encontrás fruta, después cuál
            const puertasDisponibles = frutasFiltradas.reduce((s, f) => s + (Number(f.puertas) || 0), 0);
            if (puertasDisponibles === 0) {
                await responder('@' + displayName + ' No quedan frutas disponibles. Volvé más tarde.');
                return;
            }
            const probExito = puertasDisponibles / TOTAL_PUERTAS_JUEGO;
            if (Math.random() >= probExito) {
                // 40% de las veces que fallás, en vez de nada, sale un meme
                if (Math.random() < 0.40) {
                    const meme = MEMES_FRUTAS[Math.floor(Math.random() * MEMES_FRUTAS.length)];
                    await updateUsuario(username, { fruta_pendiente: 'meme:' + meme.nombre });
                    console.log('🍊 Meme encontrado: ' + username + ' → ' + meme.nombre);
                    await responder('@' + displayName + ' ¡Encontraste una ' + meme.nombre + ' ' + meme.emoji + '!');
                    return;
                }
                await responder('@' + displayName + ' No encontraste nada esta vez. Volvé a intentar más tarde.');
                return;
            }
            let rp = Math.random() * puertasDisponibles;
            for (let i = 0; i < frutasFiltradas.length; i++) {
                rp -= (Number(frutasFiltradas[i].puertas) || 0);
                if (rp <= 0) { selectedFruit = frutasFiltradas[i]; break; }
            }
            if (!selectedFruit) selectedFruit = frutasFiltradas[frutasFiltradas.length - 1];
        }
        if (selectedFruit.evento) {
            await updateUsuario(username, {
                evento_fruta_tipo: 'fruta', evento_fruta_fase: 'avistamiento',
                evento_fruta_nombre: selectedFruit.nombre, evento_fruta_nivel: selectedFruit.nivel || 1,
                evento_fruta_estado: 'pendiente', evento_fruta_comandos: 'si_no',
                evento_fruta_comida_por_otro: false
            });
            console.log('🍎 Fruta encontrada: ' + username + ' → ' + selectedFruit.nombre + ' (evento)');
            await responder('@' + displayName + ' ' + selectedFruit.fase1 + ' — ✅ !si o ❌ !no');
        } else {
            await updateUsuario(username, { fruta_pendiente: selectedFruit.nombre });
            console.log('🍎 Fruta encontrada: ' + username + ' → ' + selectedFruit.nombre + ' (sin evento)');
            const descSinEvento = (selectedFruit.descripcion || '').replace(/\n/g, ' ').trim();
            await responder('@' + displayName + ' ¡Encontraste la ' + selectedFruit.nombre + ' ' + (selectedFruit.emoji || '') + '! ' + descSinEvento + ' ⚔️ ' + displayStat(selectedFruit.ataque || 0) + ' | 🛡️ ' + displayStat(selectedFruit.defensa || 0) + ' | 🧠 ' + displayStat(selectedFruit.utilidad || 0) + ' — !comer o !rechazar');
        }
    } catch (err) {
        console.error('❌ !fruta:', err);
        await responder('@' + displayName + ' Error.');
    }
}

// ============================================
// !COMER / !RECHAZAR / !SI / !NO / !PELEAR / !HUIR — fruta (chat o susurro)
// ============================================
async function procesarComer(username, displayName, fromUserId, esSusurro, chatChannel) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (user && user.fruta_pendiente && user.fruta_pendiente.startsWith('meme:')) {
        const nombreMeme = user.fruta_pendiente.slice(5);
        const meme = MEMES_FRUTAS.find(m => m.nombre === nombreMeme);
        await updateUsuario(username, { fruta_pendiente: null });
        if (meme) {
            await responder('@' + displayName + ' ' + meme.comer);
        } else {
            await responder('@' + displayName + ' Te comiste algo raro.');
        }
        return;
    }
    if (user && user.fruta_pendiente) {
        const frutaConsumida = user.fruta_pendiente;
        const { data: frutaData } = await supabase.from('frutas').select('descripcion, emoji, poder_fruta').eq('nombre', frutaConsumida).single();
        const updateData = user.fruta
            ? { fruta_2: frutaConsumida, fruta_pendiente: null }
            : { fruta: frutaConsumida, fruta_pendiente: null };
        await updateUsuario(username, updateData);
        await supabase.from('frutas').update({ disponible: false }).eq('nombre', frutaConsumida);
        console.log('🍎 Fruta consumida: ' + username + ' → ' + frutaConsumida + (user.fruta ? ' (2da)' : ''));
        await responder('@' + displayName + ' Consumiste la ' + frutaConsumida + ' ' + ((frutaData && frutaData.emoji) || '') + '.');
        // Marcar a otros usuarios que tenían la misma fruta pendiente
        const pcfFruta = (frutaData && frutaData.poder_fruta) ? Math.round(frutaData.poder_fruta) : 0;
        const { data: otrosPendientes } = await supabase.from('usuarios')
            .select('username, twitch_user_id')
            .eq('fruta_pendiente', frutaConsumida)
            .neq('username', username);
        if (otrosPendientes && otrosPendientes.length > 0) {
            for (const otro of otrosPendientes) {
                await updateUsuario(otro.username, {
                    fruta_pendiente: null,
                    fruta_perdida_por: username,
                    fruta_perdida_pcf: pcfFruta
                });
                await notificar(otro.username, otro.twitch_user_id, '¿Y tu fruta? ¿Habría jurado que había una fruta aquí... Nooo, pestañaste, y @' + username + ' te la primereó');
            }
        }
    } else {
        await responder('@' + displayName + ' FELICIDADES TE COMISTE... ESTA 🫱');
    }
}

async function procesarRechazar(username, displayName, fromUserId, esSusurro, chatChannel) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (user && user.fruta_pendiente && user.fruta_pendiente.startsWith('meme:')) {
        const nombreMeme = user.fruta_pendiente.slice(5);
        const meme = MEMES_FRUTAS.find(m => m.nombre === nombreMeme);
        await updateUsuario(username, { fruta_pendiente: null });
        if (meme) {
            await responder('@' + displayName + ' ' + meme.rechazar);
        } else {
            await responder('@' + displayName + ' La rechazaste.');
        }
        return;
    }
    if (user && user.fruta_pendiente) {
        await updateUsuario(username, { fruta_pendiente: null });
        await responder('@' + displayName + ' Rechazaste la ' + user.fruta_pendiente + '.');
    } else if (user && user.fruta) {
        await responder('@' + displayName + ' Ya tenés fruta.');
    } else {
        await responder('@' + displayName + ' Como te rechazaron toda tu vida, ¿no?');
    }
}

async function procesarSi(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
        await responder('@' + displayName + ' No corresponde.'); return;
    }
    const { data: frutaCheckSi } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    const filtroSi = canalDb ? canalDb.episodio_filtro : null;
    if (frutaCheckSi && !pasaFiltroEpisodio(frutaCheckSi, filtroSi)) {
        await responder('@' + displayName + ' 📖 Esta fruta todavía no se vio en este canal. Podés continuar en el chat del canal donde la encontraste, o en el chat de op_d_bot.');
        return;
    }
    if (user.evento_fruta_comida_por_otro) {
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        await responder('@' + displayName + ' La fruta ya fue consumida.'); return;
    }
    await updateUsuario(username, { evento_fruta_fase: 'encuentro', evento_fruta_comandos: 'pelear_huir' });
    const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    const calaverasSi = await getCalaverasEventoFruta(user, fruta);
    await responder('@' + displayName + ' ' + calaverasSi + ' ' + fruta.fase2 + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' ⚔️ ' + displayStat(fruta.ataque || 0) + ' | 🛡️ ' + displayStat(fruta.defensa || 0) + ' | 🧠 ' + displayStat(fruta.utilidad || 0) + ' ¿Qué harás? — ⚔️ !pelear o 🏃 !huir');
}

async function procesarNo(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
        await responder('@' + displayName + ' No corresponde.'); return;
    }
    const { data: frutaFiltroNo } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    const filtroNo = canalDb ? canalDb.episodio_filtro : null;
    if (frutaFiltroNo && !pasaFiltroEpisodio(frutaFiltroNo, filtroNo)) {
        await responder('@' + displayName + ' 📖 Esta fruta todavía no se vio en este canal. Podés continuar en el chat del canal donde la encontraste, o en el chat de op_d_bot.');
        return;
    }
    await updateUsuario(username, {
        evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
        evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
        evento_fruta_comida_por_otro: false
    });
    await responder('@' + displayName + ' Te retirás.');
}

async function procesarPelear(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
        await responder('@' + displayName + ' No corresponde.'); return;
    }
    const { data: frutaFiltroPl } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    const filtroPl = canalDb ? canalDb.episodio_filtro : null;
    if (frutaFiltroPl && !pasaFiltroEpisodio(frutaFiltroPl, filtroPl)) {
        await responder('@' + displayName + ' 📖 Esta fruta todavía no se vio en este canal. Podés continuar en el chat del canal donde la encontraste, o en el chat de op_d_bot.');
        return;
    }
    if (user.evento_fruta_comida_por_otro) {
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        await responder('@' + displayName + ' La fruta ya fue consumida.'); return;
    }
    const { data: frutaData } = await supabase.from('frutas').select('poder_fruta, sombra, emoji').eq('nombre', user.evento_fruta_nombre).single();
    const poderFrutaUsuario = (frutaData && frutaData.poder_fruta) ? frutaData.poder_fruta : 0;
    const nombreSombra = (frutaData && frutaData.sombra) ? frutaData.sombra : null;
    const emojiFruta = (frutaData && frutaData.emoji) || '';
    const supArm = await esSupremoArmadura(username);
    const supObs = await esSupremoObservacion(username);
    const supConq = await esSupremoConquistador(username);
    const poderUsuario = poderFrutaUsuario
        + calcularAporteArmadura(user.armadura || 0, supArm)
        + calcularAporteObservacion(user.observacion || 0, supObs)
        + calcularAporteConquistador(user.conquistador || 0, supConq);
    let poderEnemigoBase = 80;
    let npcSombra = null;
    if (nombreSombra) {
        const { data: npc } = await supabase.from('npcs').select('pcf_final, pcf_calculado, recompensa_conquistador, recompensa_berries').eq('nombre', nombreSombra).maybeSingle();
        npcSombra = npc;
        poderEnemigoBase = (npc && (npc.pcf_final || npc.pcf_calculado)) || 80;
    } else poderEnemigoBase = 20 + (user.evento_fruta_nivel || 4) * 15;
    const probVictoria = 1 / (1 + Math.pow(poderEnemigoBase / poderUsuario, EXP_PROB));
    const victoria = Math.random() < probVictoria;
    const resultado = calcularCombate(poderUsuario, poderEnemigoBase);
    // El porcentaje de calcularCombate refleja la variación de poderes (±5%).
    // Si la nueva victoria no coincide con la del combate simulado, invertimos el signo
    // para que el mensaje sea coherente con el resultado real.
    let porcentaje = resultado.porcentaje;
    if ((victoria && porcentaje < 0) || (!victoria && porcentaje > 0)) {
        porcentaje = -porcentaje;
    }
    const nivel = user.evento_fruta_nivel || 4;
    const mensaje = obtenerMensajeCombate(victoria, porcentaje);
    const hakiUFrut = await formatearHakiLog(user);
    const rivalLogFruta = nombreSombra ? (nombreSombra + ' (sombra)') : ('sombra nivel ' + nivel);
    console.log('[FRUTA] ' + username + ' vs ' + rivalLogFruta + ' | PCF ' + poderUsuario + ' vs ' + poderEnemigoBase + ' | Prob ' + (probVictoria * 100).toFixed(1) + '% | Haki U: ' + hakiUFrut + ' | ' + (victoria ? 'VICTORIA' : 'DERROTA'));
    if (victoria) {
        const recConq = nivel * 5;
        const recBerries = redondearBonito(nivel * 1000000);
        const { data: usuariosConFrutaLista } = await supabase.from('usuarios').select('username')
            .or('fruta.eq."' + user.evento_fruta_nombre + '",fruta_2.eq."' + user.evento_fruta_nombre + '"').limit(1);
        const usuarioConFruta = (usuariosConFrutaLista && usuariosConFrutaLista.length > 0) ? usuariosConFrutaLista[0] : null;
        if (usuarioConFruta) {
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConq,
                recompensa_delta: (user.recompensa_delta || 0) + recBerries,
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            await responder('@' + displayName + ' ' + mensaje + ' Pero ya fue consumida.'); return;
        }
        const updateFrutaData = user.fruta
            ? { fruta_2: user.evento_fruta_nombre }
            : { fruta: user.evento_fruta_nombre };
        chequearHakiCambio('conquistador', user.conquistador, (user.conquistador || 0) + recConq);
        await updateUsuario(username, {
            conquistador: (user.conquistador || 0) + recConq,
            recompensa_delta: (user.recompensa_delta || 0) + recBerries,
            ...updateFrutaData,
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        await supabase.from('frutas').update({ disponible: false }).eq('nombre', user.evento_fruta_nombre);
        await responder('@' + displayName + ' ' + mensaje + ' 🍎 ¡Obtuviste la ' + user.evento_fruta_nombre + ' ' + emojiFruta + '!');
        const { data: afectados } = await supabase.from('usuarios').select('username, twitch_user_id')
            .eq('evento_fruta_nombre', user.evento_fruta_nombre)
            .eq('evento_fruta_estado', 'pendiente').neq('username', username);
        if (afectados && afectados.length > 0) {
            const pcfFruta = Math.round(poderFrutaUsuario);
            for (const a of afectados) {
                await updateUsuario(a.username, {
                    evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                    evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                    evento_fruta_comida_por_otro: false,
                    fruta_perdida_por: username,
                    fruta_perdida_pcf: pcfFruta
                });
                await notificar(a.username, a.twitch_user_id, '¿Y tu fruta? ¿Habría jurado que había una fruta aquí... Nooo, pestañaste, y @' + username + ' te la primereó');
                console.log('🍎 Fruta perdida: ' + a.username + ' perdió evento de ' + user.evento_fruta_nombre);
            }
        }
    } else {
        let castigoConq = 1;
        let castigoBerries = 2000000;
        if (npcSombra && (npcSombra.pcf_final || npcSombra.pcf_calculado)) {
            const pcfNpc = npcSombra.pcf_final || npcSombra.pcf_calculado;
            const prob = calcularProbabilidadVictoria(poderUsuario, pcfNpc);
            const castExplorar = calcularRecompensasExplorar(
                { recompensa_conquistador: npcSombra.recompensa_conquistador, recompensa_berries: npcSombra.recompensa_berries },
                prob, false, 'medio'
            );
            castigoConq = Math.max(Math.round(castExplorar.conq * 0.35), 1);
            castigoBerries = Math.max(redondearBonito(castExplorar.berries * 0.35), 100000);
        }
        chequearHakiCambio('conquistador', user.conquistador, Math.max((user.conquistador || 0) - castigoConq, 0));
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigoConq, 0),
            recompensa_delta: (user.recompensa_delta || 0) - castigoBerries,
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        await responder('@' + displayName + ' ' + mensaje + ' 💀 -' + castigoConq + ' Conq. -$' + castigoBerries.toLocaleString('es-AR'));
    }
}

async function procesarHuir(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
        await responder('@' + displayName + ' No corresponde.'); return;
    }
    const { data: frutaFiltroHu } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    const filtroHu = canalDb ? canalDb.episodio_filtro : null;
    if (frutaFiltroHu && !pasaFiltroEpisodio(frutaFiltroHu, filtroHu)) {
        await responder('@' + displayName + ' 📖 Esta fruta todavía no se vio en este canal. Podés continuar en el chat del canal donde la encontraste, o en el chat de op_d_bot.');
        return;
    }
    await updateUsuario(username, {
        evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
        evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
        evento_fruta_comida_por_otro: false
    });
    await responder('@' + displayName + ' Huiste.');
}

// ============================================
// !FRUTAPENDIENTE — ver fruta pendiente (chat o susurro)
// ============================================
async function procesarFrutapendiente(username, displayName, fromUserId, esSusurro, chatChannel, canalDb) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user) return;
    // 1. Prioridad: Fruta normal pendiente (sin evento)
    if (user.fruta_pendiente) {
        if (user.fruta_pendiente.startsWith('meme:')) {
            const meme = MEMES_FRUTAS.find(m => m.nombre === user.fruta_pendiente.slice(5));
            if (meme) {
                await responder('@' + displayName + ' Tenés pendiente la ' + meme.nombre + ' ' + meme.emoji + ' — !comer o !rechazar');
                return;
            }
        }
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.fruta_pendiente).single();
        if (fruta) {
            await responder('@' + displayName + ' Tenés pendiente la ' + fruta.nombre + ' ' + (fruta.emoji || '') + '. ' + (fruta.descripcion || '') + ' ⚔️ ' + displayStat(fruta.ataque || 0) + ' | 🛡️ ' + displayStat(fruta.defensa || 0) + ' | 🧠 ' + displayStat(fruta.utilidad || 0) + ' — !comer o !rechazar');
            return;
        }
    }
    // 2. Si no hay normal, buscar evento
    if (user.evento_fruta_estado !== 'pendiente') {
        await responder('@' + displayName + ' No tenés evento de fruta pendiente.'); return;
    }
    if (user.evento_fruta_comida_por_otro) {
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        await responder('@' + displayName + ' La fruta ya fue consumida.'); return;
    }
    const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
    if (!fruta) { await responder('@' + displayName + ' Error.'); return; }
    const filtroFP = canalDb ? canalDb.episodio_filtro : null;
    if (!pasaFiltroEpisodio(fruta, filtroFP)) {
        await responder('@' + displayName + ' 📖 Esta fruta todavía no se vio en este canal. Podés continuar en el chat del canal donde la encontraste, o en el chat de op_d_bot.');
        return;
    }
    if (user.evento_fruta_fase === 'avistamiento') {
        await responder('@' + displayName + ' ' + fruta.fase1 + ' — ✅ !si o ❌ !no');
    } else {
        const calaverasFP = await getCalaverasEventoFruta(user, fruta);
        await responder('@' + displayName + ' ' + calaverasFP + ' ' + fruta.fase2 + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' ⚔️ ' + displayStat(fruta.ataque || 0) + ' | 🛡️ ' + displayStat(fruta.defensa || 0) + ' | 🧠 ' + displayStat(fruta.utilidad || 0) + ' ¿Qué harás? — ⚔️ !pelear o 🏃 !huir');
    }
}

// ============================================
// HANDLER DE SUSURROS
// ============================================
async function handleWhisper(event) {
    const fromUserId = event.from_user_id;
    const fromUserLogin = event.from_user_login;
    const messageText = event.whisper.text.trim();
    const args = messageText.split(' ');
    const command = normalizarComando(args[0]);
    const username = fromUserLogin.toLowerCase();

    if (!fromUserId) return;
    if (!command.startsWith('!')) return;

    // Modo mantenimiento: solo los comandos de deploy confirm funcionan
    if (mantenimientoActivo && command !== '!deploylisto' && command !== '!deplis') return;

    // Predeploy: bloquea duelos y coliseos
    if (predeployActivo && (command === '!retar' || command === '!duelo' || command === '!coliseo')) {
        await sendWhisper(fromUserId, '⏳ El bot se prepara para mantenimiento. Esperá un momento.');
        return;
    }

    // Bloqueo por coliseo activo (aplica en susurro para cerrar el agujero de !explorar)
    const COMANDOS_BLOQUEADOS_COLISEO_WHISPER = [
        '!op', '!fruta', '!comer', '!pelear', '!retar', '!aceptarduelo',
        '!explorar', '!facil', '!medio', '!dificil', '!continuar', '!retroceder',
        '!combatir', '!retirarse', '!exploracionpendiente'
    ];
    if (COMANDOS_BLOQUEADOS_COLISEO_WHISPER.includes(command)) {
        const userCol = await getUsuario(username);
        if (userCol && userCol.coliseo_canal) {
            const col = await getColiseo(userCol.coliseo_canal);
            if (col && col.estado === 'ventana') {
                await sendWhisper(fromUserId, '⏳ Estás en un Coliseo activo. Esperá a que termine.');
                return;
            }
        }
    }

    if (command === '!testwhisper') {
        await sendWhisper(fromUserId, '¡Hola ' + fromUserLogin + '! Funciona. 🎉');
        return;
    }
    if ((command === '!ayuda' || command === '!ayudaop') && !args[1]) { await sendWhisper(fromUserId, AYUDA_MENU); return; }
    if (command === '!ayudachat') {
        const esStreamer = !!(await getCanal(username));
        await sendWhisper(fromUserId, esStreamer ? AYUDA_CHAT_STREAMER : AYUDA_CHAT);
        return;
    }
    if (command === '!ayudasusurro') { await sendWhisper(fromUserId, AYUDA_SUSURRO); return; }

    // !ayuda <tema>
    if (command === '!ayuda' && args[1]) {
        const tema = normalizarComando(args[1]);
        if (AYUDA_TEMAS[tema]) {
            await sendWhisper(fromUserId, AYUDA_TEMAS[tema]);
        } else {
            await sendWhisper(fromUserId, 'eh?');
        }
        return;
    }

    if (command === '!actualizacion') {
        if (!commitInfo) { await sendWhisper(fromUserId, '🔄 Cargando...'); return; }
        const fecha = new Date(commitInfo.fecha);
        const fechaStr = fecha.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        await sendWhisper(fromUserId, '🔄 ' + fechaStr + ' | ' + commitInfo.mensaje);
        return;
    }
    // !scan (solo dueño)
    if (command === '!scan') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        await sendWhisper(fromUserId, '⏳ Escaneando chatters...');
        for (const canal of CANALES_CON_LURK) {
            await escanearChatters(canal);
        }
        await sendWhisper(fromUserId, '✅ Scan completado. Revisá los logs.');
        return;
    }
    // !agregarcanal xxxxx (solo dueño)
    if (command === '!agregarcanal') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        if (!args[1]) {
            await sendWhisper(fromUserId, 'Uso: !agregarcanal nombre_del_canal');
            return;
        }
        const nuevoCanal = args[1].toLowerCase().trim();
        // Validar formato (solo letras, números, guiones bajos)
        if (!/^[a-z0-9_]{3,25}$/.test(nuevoCanal)) {
            await sendWhisper(fromUserId, '❌ Nombre de canal inválido. Solo letras, números y guiones bajos (3-25 caracteres).');
            return;
        }
        // ¿Ya existe?
        const canalExistente = await getCanal(nuevoCanal);
        if (canalExistente) {
            await sendWhisper(fromUserId, '⚠️ El canal "' + nuevoCanal + '" ya está agregado.');
            return;
        }
        // Crear en DB
        const { error: errInsert } = await supabase
            .from('canales')
            .insert([{ canal: nuevoCanal, bot_activo: true, lurk_activo: true, fecha_ultimo_cambio: new Date().toISOString() }]);
        if (errInsert) {
            console.error('❌ Error agregando canal:', errInsert.message);
            await sendWhisper(fromUserId, '❌ Error al agregar el canal. Revisá los logs.');
            return;
        }
        // Unirse al IRC
        try {
            await client.join(nuevoCanal);
            console.log('📡 Canal agregado: ' + nuevoCanal + ' (con lurk)');
            await sendWhisper(fromUserId, '✅ Canal "' + nuevoCanal + '" agregado. Lurk activo. El bot se unió al chat.');
        } catch (e) {
            console.error('❌ Error uniendo al IRC:', e);
            await sendWhisper(fromUserId, '⚠️ Canal agregado a la DB, pero no se pudo unir al IRC (¿el bot tiene permiso?). Revisá los logs.');
        }
        return;
    }

    // !predeploy (solo dueño)
    if (command === '!predeploy') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        await setPredeploy(true);
        const ventanas = await contarVentanasColiseo();
        if (ventanas === 0) {
            await sendWhisper(fromUserId, '🔧 Predeploy activo. Sin ventanas abiertas. Podés hacer el deploy cuando quieras.');
        } else {
            await sendWhisper(fromUserId, '🔧 Predeploy activo. ⚠️ Hay ' + ventanas + ' ventana(s) de coliseo abiertas. Esperá a que cierren.');
        }
        console.log('🔧 Predeploy activado por ' + username + '. Ventanas abiertas: ' + ventanas);
        return;
    }

    // !deploy / !dep (solo dueño). !dep = sin avisos a canales.
    if (command === '!deploy' || command === '!dep') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        const avisarCanales = (command === '!deploy');
        // Snapshot: guardar quiénes tienen bloque abierto y timestamp
        const { data: abiertos } = await supabase.from('lurkv2')
            .select('usuario').not('join_actual', 'is', null);
        const snapshotList = (abiertos || []).map(a => a.usuario);
        await supabase.from('bot_config').upsert({ clave: 'deploy_timestamp', valor: new Date().toISOString() });
        await supabase.from('bot_config').upsert({ clave: 'deploy_snapshot', valor: JSON.stringify(snapshotList) });
        // Activar mantenimiento
        await setMantenimiento(true);
        // Cerrar bloques abiertos
        let cerrados = 0;
        if (abiertos) {
            for (const a of abiertos) {
                await lurkCerrarBloque(a.usuario);
                cerrados++;
            }
        }
        const avisados = [];
        if (avisarCanales) {
            // Avisar a todos los canales (incluye los offop)
            const canales = await getCanales();
            const msg = '🔧 El bot entrará en mantenimiento. No va a funcionar hasta nuevo aviso. Disculpen las molestias.';
            for (const c of canales) {
                // Si es canal con lurk, solo avisamos si está live
                if (canalTieneLurk(c.canal)) {
                    const live = await checkLiveHelix(c.canal);
                    if (!live) continue;
                }
                try { client.say(c.canal, msg); avisados.push(c.canal); } catch (e) {}
            }
        }
        console.log('🚀 Deploy preparado (' + (avisarCanales ? 'con avisos' : 'SILENCIOSO') + '). Bloques cerrados: ' + cerrados + '. Avisados: ' + avisados.join(', '));
        if (avisarCanales) {
            await sendWhisper(fromUserId, '✅ Deploy preparado. Bloques: ' + cerrados + '. Avisados: ' + (avisados.join(', ') || 'ninguno'));
        } else {
            await sendWhisper(fromUserId, '✅ Deploy preparado (SILENCIOSO). Bloques cerrados: ' + cerrados + '.');
        }
        return;
    }

    // !deploylisto / !deplis (solo dueño). !deplis = sin avisos a canales.
    if (command === '!deploylisto' || command === '!deplis') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        const avisarCanales = (command === '!deploylisto');
        // Leer snapshot
        const { data: snapData } = await supabase.from('bot_config').select('valor').eq('clave', 'deploy_snapshot').maybeSingle();
        const { data: tsData } = await supabase.from('bot_config').select('valor').eq('clave', 'deploy_timestamp').maybeSingle();
        const snapshot = snapData ? JSON.parse(snapData.valor || '[]') : [];
        const deployTs = tsData ? tsData.valor : '';
        // Escanear chatters actuales (abre bloques de los que están ahora)
        for (const canal of CANALES_CON_LURK) {
            await escanearChatters(canal);
        }
        // Para cada uno del snapshot que tiene bloque abierto ahora → sumar minutos del deploy
        if (snapshot.length > 0 && deployTs) {
            const minutosDeploy = Math.max(0, Math.floor((Date.now() - new Date(deployTs).getTime()) / 60000));
            for (const u of snapshot) {
                const v2 = await getLurkV2(u);
                if (!v2 || !v2.join_actual || v2.completo) continue;
                if (minutosDeploy > 0) {
                    const totalDespues = (v2.minutos_hoy || 0) + minutosDeploy;
                    const postasNuevasSnapshot = Math.min(3, calcularPostasPorMinutos(totalDespues));
                    await updateLurkV2(u, {
                        minutos_hoy: totalDespues,
                        postas_hoy: postasNuevasSnapshot
                    });
                    const userFresh = await getUsuario(u);
                    if (userFresh) {
                        await updateUsuario(u, { minutos_lurk: (userFresh.minutos_lurk || 0) + minutosDeploy });
                    }
                    console.log('🔧 Snapshot lurk: ' + u + ' +' + minutosDeploy + ' min (deploy)');
                }
            }
        }
        // Limpiar snapshot y desactivar mantenimiento + predeploy
        await supabase.from('bot_config').upsert({ clave: 'deploy_snapshot', valor: '' });
        await supabase.from('bot_config').upsert({ clave: 'deploy_timestamp', valor: '' });
        await setMantenimiento(false);
        await setPredeploy(false);
        const avisados = [];
        if (avisarCanales) {
            // Avisar a canales
            const canales = await getCanales();
            const msg = '✅ El bot ya está funcionando de nuevo. ¡Gracias por esperar!';
            for (const c of canales) {
                if (canalTieneLurk(c.canal)) {
                    const live = await checkLiveHelix(c.canal);
                    if (!live) continue;
                }
                try { client.say(c.canal, msg); avisados.push(c.canal); } catch (e) {}
            }
        }
        console.log('🚀 Deploy confirmado (' + (avisarCanales ? 'con avisos' : 'SILENCIOSO') + '). Avisados: ' + avisados.join(', '));
        if (avisarCanales) {
            await sendWhisper(fromUserId, '✅ Aviso enviado a: ' + (avisados.join(', ') || 'ninguno'));
        } else {
            await sendWhisper(fromUserId, '✅ Deploy confirmado (SILENCIOSO). Bot activo de nuevo.');
        }
        return;
    }

    // !perder (solo dueño, solo por susurro, funciona aunque esté en coliseo)
    if (command === '!perder') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        // Buscar coliseo en el que esté el dueño y marcarlo
        const { data: coliseos } = await supabase.from('coliseo').select('*').eq('estado', 'ventana');
        for (const c of (coliseos || [])) {
            const participantes = c.participantes || [];
            const idx = participantes.findIndex(p => p.username === username);
            if (idx >= 0) {
                const nuevos = [...participantes];
                nuevos[idx] = { ...nuevos[idx], forzar_derrota: true };
                await guardarColiseo(c.canal, { participantes: nuevos });
                break;
            }
        }
        await sendWhisper(fromUserId, 'Listo.');
        return;
    }

    // !op
    if (command === '!op') {
        await procesarOp(username, fromUserLogin, fromUserId, true, null);
        return;
    }

    // !observacion
    if (command === '!observacion') {
        if (!cooldownsLurk[username]) cooldownsLurk[username] = {};
        if (cooldownsLurk[username].observacion && Date.now() - cooldownsLurk[username].observacion < 30000) {
            await sendWhisper(fromUserId, '⏳ Esperá unos segundos.'); return;
        }
        cooldownsLurk[username].observacion = Date.now();
        await inicializarDiaLurkV2(username);
        const v2Obs = await getLurkV2(username);
        let canalActivoObs = false;
        for (const canal of CANALES_CON_LURK) {
            if (await canalEstaActivo(canal)) { canalActivoObs = true; break; }
        }
        if (v2Obs && !v2Obs.completo && !v2Obs.join_actual && v2Obs.ultimo_dia === getFechaHoy() && canalActivoObs) {
            await updateLurkV2(username, { join_actual: new Date().toISOString() });
        }
        await mostrarObservacion(username, fromUserId);
        return;
    }

    // !canaleson
    if (command === '!canaleson') {
        if (cooldownsCanaleson[username] && Date.now() - cooldownsCanaleson[username] < 5 * 60 * 1000) {
            const restante = 5 * 60 * 1000 - (Date.now() - cooldownsCanaleson[username]);
            const min = Math.ceil(restante / 60000);
            await sendWhisper(fromUserId, 'PARAAAAAA LOCURA... te podría decir ahora pero te sentás tranquilamente y esperás (' + min + ' min)');
            return;
        }
        cooldownsCanaleson[username] = Date.now();
        const canales = await getCanales();
        const activos = [];
        for (const c of canales) {
            if (!c.bot_activo) continue;
            const live = await checkLiveHelix(c.canal);
            if (live) activos.push(c.canal);
        }
        if (activos.length === 0) {
            await sendWhisper(fromUserId, '📡 No hay canales activos en vivo ahora mismo.');
        } else {
            await sendWhisper(fromUserId, '📡 Canales activos: ' + activos.join(', '));
        }
        return;
    }

    // !personaje X (nombre completo, puede tener espacios)
    if (command === '!personaje') {
        if (!args[1]) { await sendWhisper(fromUserId, 'Uso: !personaje <nombre>'); return; }
        const nombreCompleto = args.slice(1).join(' ');
        await procesarPersonaje(username, nombreCompleto, fromUserId);
        return;
    }

    if (command === '!infoop' && !args[1]) {
        const user = await getUsuario(username);
        if (!user) { await sendWhisper(fromUserId, 'Error al obtener datos.'); return; }
        const supArm = await esSupremoArmadura(username);
        const supObs = await esSupremoObservacion(username);
        const supConq = await esSupremoConquistador(username);
        const lurkInfo = await getLurkV2(username);
        const duelosHoy = await contarDuelosHoy(username);
        // ¿Puede buscar fruta?
        const tieneYami = user.fruta === 'Yami Yami no Mi';
        const puedeBuscarFruta = !user.fruta || (tieneYami && !user.fruta_2);

        // Armar texto de fruta
        let frutaTexto = '🍎 Ninguna';
        if (user.fruta) {
            const { data: f } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = '🍎 ' + user.fruta + ' ' + ((f && f.emoji) || '');
            if (user.fruta_2) {
                const { data: f2 } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta_2).single();
                frutaTexto += ' + ' + user.fruta_2 + ' ' + ((f2 && f2.emoji) || '');
            }
        }

        const hoyInfo = getFechaHoy();
        const opUsosHoy = (user.ultimo_op_fecha === hoyInfo) ? (user.op_usos_hoy || 0) : 0;
        const frutaUsosHoy = (user.ultimo_dia_fruta === hoyInfo) ? (user.fruta_intentos_hoy || 0) : 0;

        // Estado de !fruta (solo si puede tirarlo)
        let estadoFruta = '';
        if (puedeBuscarFruta) {
            if (frutaUsosHoy >= FRUTA_LIMITE_DIARIO) {
                estadoFruta = ' (' + frutaUsosHoy + '/5 🗓️✅)';
            } else {
                const ultimoFrutaTs = cooldowns['fruta_' + username] || 0;
                const restFruta = COOLDOWN_FRUTA - (Date.now() - ultimoFrutaTs);
                if (restFruta > 0) {
                    const m = Math.floor(restFruta / 60000);
                    const s = Math.floor((restFruta % 60000) / 1000);
                    estadoFruta = ' (' + frutaUsosHoy + '/5 ⏳ ' + (m > 0 ? (m + 'm ' + s + 's') : (s + 's')) + ')';
                } else {
                    estadoFruta = ' (' + frutaUsosHoy + '/5 ⌛✅)';
                }
            }
        }
        frutaTexto += estadoFruta;

        // Estado de !op
        let opTxt;
        if (opUsosHoy >= 3) {
            opTxt = '🎮 !op: ' + opUsosHoy + '/3 🗓️✅';
        } else {
            const ultimoOpTs = user.ultimo_op_timestamp ? new Date(user.ultimo_op_timestamp).getTime() : 0;
            const restOp = (10 * 60 * 1000) - (Date.now() - ultimoOpTs);
            if (restOp > 0) {
                const m = Math.floor(restOp / 60000);
                const s = Math.floor((restOp % 60000) / 1000);
                opTxt = '🎮 !op: ' + opUsosHoy + '/3 ⏳ ' + (m > 0 ? (m + 'm ' + s + 's') : (s + 's'));
            } else {
                opTxt = '🎮 !op: ' + opUsosHoy + '/3 ⌛✅';
            }
        }

        // Rangos de haki
        const rangoArm = getRangoArmadura(user.armadura || 0, supArm);
        const rangoObs = getRangoObservacion(user.observacion || 0, supObs);
        const rangoConq = getRangoConquistador(user.conquistador || 0, supConq);

        // Postas (con progreso del bloque abierto)
        let minLurkHoy = (lurkInfo && lurkInfo.minutos_hoy) || 0;
        if (lurkInfo && lurkInfo.join_actual && !lurkInfo.completo) {
            const transcurridos = Math.max(0, Math.floor((Date.now() - new Date(lurkInfo.join_actual).getTime()) / 60000));
            minLurkHoy += transcurridos;
        }
        const postasHoy = Math.min(3, calcularPostasPorMinutos(minLurkHoy));

        // Explorar
        let estadoExplorar = '🗺️ disponible';
        if (user.evento_explorar_estado === 'pendiente') estadoExplorar = '🗺️ pendiente';
        else {
            const cd = await puedeExplorar(user);
            if (!cd.ok) estadoExplorar = '🗺️ usada. Próxima en ' + formatTiempoRestante(cd.restante);
        }

        // Recompensa
        const recompensaReal = await getRecompensaReal(user);
        await updateUsuario(username, { recompensa_publica: recompensaReal });
        const rangoRecS = await getRangoRecompensa(username);
        let sufijoRangoS = '';
        if (rangoRecS) sufijoRangoS = ' ' + getEmojiRango(rangoRecS) + ' ' + getNombreRango(rangoRecS);

        // Armado del mensaje (1 línea)
        const partes = [
            frutaTexto,
            '🛡️ ' + rangoArm.nombre + ' (' + (user.armadura || 0) + ') ' + rangoArm.emoji,
            '👁️ ' + rangoObs.nombre + ' (' + (user.observacion || 0) + ') ' + rangoObs.emoji,
            '⚜️ ' + rangoConq.nombre + ' (' + Math.round(user.conquistador || 0) + ') ' + rangoConq.emoji,
            opTxt,
            '🚩 Postas ' + postasHoy + '/3 (' + Math.min(minLurkHoy, 60) + 'min)',
            estadoExplorar,
            '⚔️ Duelos ' + duelosHoy + '/10',
            '💰 $' + recompensaReal.toLocaleString('es-AR') + sufijoRangoS
        ];
        const mensaje = partes.join(' | ');
        await sendWhisper(fromUserId, mensaje);
        return;
    }

    if (command === '!infoop' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target, false);
        if (!targetUser) { await sendWhisper(fromUserId, 'No encontré a @' + target + '. Verificá el nombre.'); return; }
        const supArm = await esSupremoArmadura(target);
        const supObs = await esSupremoObservacion(target);
        const supConq = await esSupremoConquistador(target);
        let frutaTexto = '🍎 Ninguna';
        if (targetUser.fruta) {
            const { data: f } = await supabase.from('frutas').select('emoji').eq('nombre', targetUser.fruta).single();
            frutaTexto = '🍎 ' + targetUser.fruta + ' ' + ((f && f.emoji) || '');
        }
        const eArm = getRangoArmadura(targetUser.armadura || 0, supArm).emoji;
        const eObs = getRangoObservacion(targetUser.observacion || 0, supObs).emoji;
        const eConq = getRangoConquistador(targetUser.conquistador || 0, supConq).emoji;
        const rangoRecT = await getRangoRecompensa(target);
        let sufijoRangoT = '';
        if (rangoRecT) sufijoRangoT = ' | ' + getEmojiRango(rangoRecT) + ' ' + getNombreRango(rangoRecT);
        await sendWhisper(fromUserId, '@' + target + ' | ' + frutaTexto + ' | 🛡️:' + eArm + ' | 👁️:' + eObs + ' | ⚜️:' + eConq + ' | 💰 $' + (targetUser.recompensa_publica || 0).toLocaleString('es-AR') + sufijoRangoT);
        return;
    }

    if (command === '!fruta') {
        await procesarFruta(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!comer') {
        await procesarComer(username, fromUserLogin, fromUserId, true, null);
        return;
    }

    if (command === '!rechazar') {
        await procesarRechazar(username, fromUserLogin, fromUserId, true, null);
        return;
    }

    if (command === '!si') {
        await procesarSi(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!no') {
        await procesarNo(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!pelear') {
        await procesarPelear(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!huir') {
        await procesarHuir(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!frutapendiente') {
        await procesarFrutapendiente(username, fromUserLogin, fromUserId, true, null, null);
        return;
    }

    if (command === '!explorar') {
        const user = await getUsuario(username);
        if (!user) { await sendWhisper(fromUserId, 'Error.'); return; }
        if (user.evento_duelo_estado === 'pendiente') {
            const otro = user.evento_duelo_retador === username ? user.evento_duelo_retado : user.evento_duelo_retador;
            await sendWhisper(fromUserId, '⚔️ Tenés un duelo pendiente con @' + otro + '. Resolvelo antes.');
            return;
        }
        const esSupObsUser = await esSupremoObservacion(username);
        if (user.evento_explorar_estado === 'pendiente') {
            // Estado pendiente: mostramos con [Pendiente] al comienzo
            if (user.evento_explorar_fase === 'menu') {
                const o = user.evento_explorar_opciones || {};
                let msg = '[Pendiente] ⏳ Ya tenés exploración en curso:';
                if (o.facil) msg += ' 🟢 !facil ' + formatearProbExplorar(o.facil.prob, esSupObsUser);
                if (o.medio) msg += ' 🟡 !medio ' + formatearProbExplorar(o.medio.prob, esSupObsUser);
                if (o.dificil) msg += ' 🔴 !dificil ' + formatearProbExplorar(o.dificil.prob, esSupObsUser);
                await sendWhisper(fromUserId, msg); return;
            }
            const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
            if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
            const o = user.evento_explorar_opciones || {};
            const op = o[user.evento_explorar_dificultad];
            if (user.evento_explorar_fase === 'avistamiento') {
                await sendWhisper(fromUserId, '[Pendiente] 📍 ' + npc.fase1 + ' ➡️ !continuar o ⬅️ !retroceder');
            } else {
                await sendWhisper(fromUserId, '[Pendiente] 📍 ' + formatearProbExplorar(op.prob, esSupObsUser) + ' ' + npc.fase2 + ' ¿Qué harás? — ⚔️ !combatir o 🏃 !retirarse');
            }
            return;
        }
        const cd = await puedeExplorar(user);
        if (!cd.ok) { await sendWhisper(fromUserId, '⏳ Próxima en ' + formatTiempoRestante(cd.restante)); return; }
        const pcfUsuario = await calcularPCFUsuario(user);
        if (pcfUsuario <= 0) {
            await sendWhisper(fromUserId, '🗺️ El mar es peligroso para alguien sin experiencia. Probá con !op o mirando un stream (podés usar !canaleson para ver si hay alguien activo con el bot)');
            return;
        }
        const factorF = getFactorRango(user.conquistador || 0);
        const opciones = await seleccionarNPCs(pcfUsuario, user.conquistador || 0, factorF);
        if (!opciones) { await sendWhisper(fromUserId, '🗺️ No encontrás rivales a tu altura todavía. Entrená con !op o mirá el stream para ganar stats y volvé a intentar.'); return; }
        await updateUsuario(username, {
            evento_explorar_estado: 'pendiente', evento_explorar_fase: 'menu',
            evento_explorar_dificultad: null, evento_explorar_npc: null, evento_explorar_nivel: null,
            evento_explorar_pcf_usuario: pcfUsuario, evento_explorar_pcf_npc: null,
            evento_explorar_comandos: null, evento_explorar_opciones: opciones,
            ultima_exploracion: new Date().toISOString(),
            ultimo_dia_exploracion: getFechaHoy(), dias_sin_explorar: 0
        });
        // Log verbose de opciones generadas (debug)
        const _fmtSignBerries = (n) => (n >= 0 ? '+' : '-') + '$' + formatBerries(Math.abs(n));
        console.log('[EXPLORAR] ' + username + ' | PCF ' + pcfUsuario + ' | F ' + factorF + ' | conq ' + (Math.round((user.conquistador || 0) * 100) / 100) + ' | max base $' + formatBerries(user.max_base_historica || 0) + ' | delta ' + _fmtSignBerries(user.recompensa_delta || 0));
        for (const _b of ['facil', 'medio', 'dificil']) {
            const _op = opciones[_b];
            if (!_op) continue;
            let _res;
            if (_op.victoria) {
                _res = 'VICTORIA | +' + Math.max(Math.round(_op.recompensa_conq * factorF), 1) + 'c / +$' + formatBerries(redondearBonito(_op.recompensa_berries));
            } else {
                _res = 'DERROTA | -' + Math.max(Math.round(_op.castigo_conq), 1) + 'c / -$' + formatBerries(redondearBonito(_op.castigo_berries));
            }
            let _forz = '';
            if (_op.forzado === 'castigo_seguro') _forz = ' | ⚠️ castigo seguro';
            else if (_op.forzado === 'victoria_forzada') _forz = ' | 🚨 VICTORIA FORZADA';
            console.log('[EXPLORAR]   ' + _b + ': ' + _op.npc + ' | PCF ' + _op.pcf_npc + ' | prob ' + (_op.prob * 100).toFixed(1) + '% | ' + _res + _forz);
        }
        const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
        const total = [f, m, d].filter(Boolean).length;
        const plural = total === 3 ? 'tres caminos' : total === 2 ? 'dos caminos' : 'un camino';
        let msg = '🗺️ ¡Zarpás! Se divisan ' + plural + ':';
        if (f) msg += ' 🟢 !facil ' + formatearProbExplorar(f.prob, esSupObsUser) + ' (+' + Math.max(Math.round(f.recompensa_conq * factorF), 1) + ' Conq / +$' + redondearBonito(f.recompensa_berries).toLocaleString('es-AR') + ')';
        if (m) msg += ' 🟡 !medio ' + formatearProbExplorar(m.prob, esSupObsUser) + ' (+' + Math.max(Math.round(m.recompensa_conq * factorF), 1) + ' Conq / +$' + redondearBonito(m.recompensa_berries).toLocaleString('es-AR') + ')';
        if (d) msg += ' 🔴 !dificil ' + formatearProbExplorar(d.prob, esSupObsUser) + ' (+' + Math.max(Math.round(d.recompensa_conq * factorF), 1) + ' Conq / +$' + redondearBonito(d.recompensa_berries).toLocaleString('es-AR') + ')';
        await sendWhisper(fromUserId, msg);
        return;
    }

    if (command === '!facil' || command === '!medio' || command === '!dificil') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'menu') {
            await sendWhisper(fromUserId, 'No tenés exploración en esa fase.'); return;
        }
        const dif = command.substring(1);
        const o = user.evento_explorar_opciones || {};
        const op = o[dif];
        if (!op) { await sendWhisper(fromUserId, 'No hay opción ' + dif + '.'); return; }
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', op.npc).single();
        if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
        await updateUsuario(username, {
            evento_explorar_fase: 'avistamiento', evento_explorar_dificultad: dif,
            evento_explorar_npc: op.npc, evento_explorar_nivel: op.nivel,
            evento_explorar_pcf_npc: op.pcf_npc, evento_explorar_comandos: 'continuar_retroceder'
        });
        await sendWhisper(fromUserId, npc.fase1 + ' ➡️ !continuar o ⬅️ !retroceder');
        return;
    }

    if (command === '!continuar') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, 'No estás en avistamiento.'); return;
        }
        await updateUsuario(username, { evento_explorar_fase: 'encuentro', evento_explorar_comandos: 'combatir_retirarse' });
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        const esSupObs = await esSupremoObservacion(username);
        await sendWhisper(fromUserId, formatearProbExplorar(op.prob, esSupObs) + ' ' + npc.fase2 + ' ¿Qué harás? — ⚔️ !combatir o 🏃 !retirarse');
        return;
    }

    if (command === '!retroceder') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, 'No estás en avistamiento.'); return;
        }
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        const rachaExpl = await calcularBonusRachaExplorar(user);
        const msgRachaExpl = rachaExpl.yaContado ? '' : ' | 🔥 Racha ' + rachaExpl.racha + 'd: +' + rachaExpl.bonus;
        const castigo = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
        chequearHakiCambio('conquistador', user.conquistador, Math.max((user.conquistador || 0) - castigo, 0) + rachaExpl.bonus);
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigo, 0) + rachaExpl.bonus,
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        });
        const msg = await getTextoExplorar('retroceder');
        await sendWhisper(fromUserId, msg + ' -' + castigo + ' Conq.' + msgRachaExpl);
        return;
    }

    if (command === '!combatir') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, 'No estás en encuentro.'); return;
        }
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        if (!op) { await sendWhisper(fromUserId, 'Error.'); return; }
        const msgCtx = await getMensajeContextualExplorar(op.victoria, op.escalon, op.margen_key);
        const hakiUExpl = await formatearHakiLog(user);
        console.log('[EXPLORAR] ' + username + ' vs ' + op.npc + ' | PCF ' + op.pcf_usuario + ' vs ' + op.pcf_npc + ' | Haki U: ' + hakiUExpl + ' | ' + (op.victoria ? 'VICTORIA' : 'DERROTA'));
        const rachaExpl = await calcularBonusRachaExplorar(user);
        const msgRachaExpl = rachaExpl.yaContado ? '' : ' | 🔥 Racha ' + rachaExpl.racha + 'd: +' + rachaExpl.bonus;
        const factorF = getFactorRango(user.conquistador || 0);
        const recConqFinal = Math.max(Math.round(op.recompensa_conq * factorF), 1);
        const recBerriesFinal = Math.max(redondearBonito(op.recompensa_berries), 0);
        const castConqFinal = Math.max(Math.round(op.castigo_conq), 1);
        const castBerriesFinal = Math.max(redondearBonito(op.castigo_berries), 0);
        if (op.victoria) {
            chequearHakiCambio('conquistador', user.conquistador, (user.conquistador || 0) + recConqFinal + rachaExpl.bonus);
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConqFinal + rachaExpl.bonus,
                recompensa_delta: (user.recompensa_delta || 0) + recBerriesFinal,
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, msgCtx + '🏆 ¡Victoria! Derrotaste a ' + op.npc + '. +' + recConqFinal + ' Conq. +$' + recBerriesFinal.toLocaleString('es-AR') + msgRachaExpl);
        } else {
            chequearHakiCambio('conquistador', user.conquistador, Math.max((user.conquistador || 0) - castConqFinal, 0) + rachaExpl.bonus);
            await updateUsuario(username, {
                conquistador: Math.max((user.conquistador || 0) - castConqFinal, 0) + rachaExpl.bonus,
                recompensa_delta: (user.recompensa_delta || 0) - castBerriesFinal,
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, msgCtx + '💀 Derrota. ' + op.npc + ' te superó. -' + castConqFinal + ' Conq. -$' + castBerriesFinal.toLocaleString('es-AR') + msgRachaExpl);
        }
        return;
    }

    if (command === '!retirarse') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, 'No estás en encuentro.'); return;
        }
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        const { data: npcData } = await supabase.from('npcs')
            .select('texto_huida, huida_sin_penalizacion')
            .eq('nombre', op.npc).single();
        const tieneHuidaEspecial = npcData && npcData.texto_huida;
        const sinPenalizacion = npcData && npcData.huida_sin_penalizacion;
        const rachaExpl = await calcularBonusRachaExplorar(user);
        const msgRachaExpl = rachaExpl.yaContado ? '' : ' | 🔥 Racha ' + rachaExpl.racha + 'd: +' + rachaExpl.bonus;
        const castigo = sinPenalizacion ? 0 : Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
        const updateData = {
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        };
        updateData.conquistador = Math.max((user.conquistador || 0) - castigo, 0) + rachaExpl.bonus;
        chequearHakiCambio('conquistador', user.conquistador, updateData.conquistador);
        await updateUsuario(username, updateData);
        if (tieneHuidaEspecial) {
            await sendWhisper(fromUserId, npcData.texto_huida + msgRachaExpl);
        } else {
            const msg = await getTextoExplorar('retirarse');
            await sendWhisper(fromUserId, msg + ' -' + castigo + ' Conq.' + msgRachaExpl);
        }
        return;
    }

    if (command === '!exploracionpendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente') {
            await sendWhisper(fromUserId, 'No tenés exploración pendiente.'); return;
        }
        const esSupObs = await esSupremoObservacion(username);
        if (user.evento_explorar_fase === 'menu') {
            const o = user.evento_explorar_opciones || {};
            let msg = '📍 Pendiente:';
            if (o.facil) msg += ' 🟢 !facil';
            if (o.medio) msg += ' 🟡 !medio';
            if (o.dificil) msg += ' 🔴 !dificil';
            await sendWhisper(fromUserId, msg); return;
        }
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
        if (user.evento_explorar_fase === 'avistamiento') {
            await sendWhisper(fromUserId, '📍 ' + npc.fase1 + ' ➡️ !continuar o ⬅️ !retroceder');
        } else {
            const o = user.evento_explorar_opciones || {};
            const op = o[user.evento_explorar_dificultad];
            await sendWhisper(fromUserId, '📍 ' + formatearProbExplorar(op.prob, esSupObs) + ' ' + npc.fase2 + ' ¿Qué harás? — ⚔️ !combatir o 🏃 !retirarse');
        }
        return;
    }

    // Duelos
    if (command === '!retar') {
        if (args.length < 2) { await sendWhisper(fromUserId, 'Uso: !retar @usuario'); return; }
        await procesarRetar(username, args[1], fromUserId, true, null);
        return;
    }
    if (command === '!aceptarduelo') { await procesarAceptarDuelo(username, fromUserId, true, null); return; }
    if (command === '!rechazarduelo') { await procesarRechazarDuelo(username, fromUserId, true, null); return; }

    if (command === '!duelopendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_duelo_estado !== 'pendiente') {
            await sendWhisper(fromUserId, 'No tenés duelo pendiente.'); return;
        }
        const retador = user.evento_duelo_retador;
        const retado = user.evento_duelo_retado;
        const otro = retador === username ? retado : retador;
        const otroUser = await getUsuario(otro);
        if (!otroUser) { await sendWhisper(fromUserId, 'Error.'); return; }
        const supArm = await esSupremoArmadura(otro);
        const supObs = await esSupremoObservacion(otro);
        const supConq = await esSupremoConquistador(otro);
        const rangoArm = getRangoArmadura(otroUser.armadura || 0, supArm);
        const rangoObs = getRangoObservacion(otroUser.observacion || 0, supObs);
        const rangoConq = getRangoConquistador(otroUser.conquistador || 0, supConq);
        const fruta = otroUser.fruta || 'Sin fruta';
        const seg = Math.max(0, Math.floor((new Date(user.evento_duelo_expira).getTime() - Date.now()) / 1000));
        const yoReto = retador === username;
        await sendWhisper(fromUserId, '⚔️ Duelo pendiente (' + (yoReto ? 'retaste' : 'te retaron') + ')\nRetador: ' + retador + '\nRetado: ' + retado + '\nRival: ' + otro + ' | 🛡️ ' + rangoArm.nombre + ' | 👁️ ' + rangoObs.nombre + ' | ⚜️ ' + rangoConq.nombre + ' | 🍎 ' + fruta + ' | 💰 $' + (otroUser.recompensa_publica || 0).toLocaleString('es-AR') + '\nRestante: ' + seg + 's');
        return;
    }

    if (command === '!historial' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        if (target === username) { await sendWhisper(fromUserId, 'No podés compararte con vos mismo.'); return; }
        const key = 'hist_' + username;
        if (cooldowns[key] && Date.now() - cooldowns[key] < 10000) {
            await sendWhisper(fromUserId, 'Esperá unos segundos.'); return;
        }
        cooldowns[key] = Date.now();
        const h = await getHistorialH2H(username, target);
        if (h.total === 0) { await sendWhisper(fromUserId, 'Nunca te enfrentaste a @' + target + '.'); return; }
        const netoTxt = h.neto > 0 ? 'Le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'Te ganó $' + formatBerries(Math.abs(h.neto)) : 'Están a mano';
        await sendWhisper(fromUserId, '📊 vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }

    // Fallback: susurro con comando desconocido (cooldown 60s por usuario)
    const COMANDOS_SUSURRO_CONOCIDOS = [
        '!testwhisper', '!ayuda', '!ayudaop', '!ayudachat', '!ayudasusurro',
        '!actualizacion', '!scan', '!agregarcanal', '!predeploy',
        '!deploy', '!dep', '!deploylisto', '!deplis', '!perder',
        '!op', '!observacion', '!canaleson', '!personaje', '!infoop',
        '!fruta', '!comer', '!rechazar', '!si', '!no', '!pelear', '!huir', '!frutapendiente',
        '!explorar', '!facil', '!medio', '!dificil', '!continuar', '!retroceder', '!combatir', '!retirarse', '!exploracionpendiente',
        '!retar', '!aceptarduelo', '!rechazarduelo', '!duelopendiente', '!historial'
    ];
    if (COMANDOS_SUSURRO_CONOCIDOS.includes(command)) return;
    if (!cooldowns['unk_' + username] || Date.now() - cooldowns['unk_' + username] > 60 * 1000) {
        cooldowns['unk_' + username] = Date.now();
        await sendWhisper(fromUserId, '🤔 Eh? Cual es ese comando máquina? Si querés, usá !ayuda para ver los disponibles.');
    }
}

// ============================================
// MOSTRAR OBSERVACIÓN
// ============================================
async function mostrarObservacion(username, fromUserId) {
    const user = await getUsuario(username);
    if (!user) return;
    const v2 = await getLurkV2(username);
    if (!v2) { await sendWhisper(fromUserId, 'Error.'); return; }
    const reg = await getLurkReg(username);
    if (!reg) { await sendWhisper(fromUserId, 'Error.'); return; }
    const supObs = await esSupremoObservacion(username);
    const rango = getRangoObservacion(user.observacion || 0, supObs);

    // Calcular progreso actual (incluyendo bloque abierto si lo hay)
    let minutosActuales = v2.minutos_hoy || 0;
    if (v2.join_actual && !v2.completo) {
        const transcurridos = Math.max(0, Math.floor((Date.now() - new Date(v2.join_actual).getTime()) / 60000));
        minutosActuales += transcurridos;
    }
    const postasActuales = Math.min(3, calcularPostasPorMinutos(minutosActuales));
    const ptsHoy = v2.puntos_hoy || 0;
    const ptsPendientes = v2.avist_pendiente || 0;
    const racha = reg.racha || 0;
    const bonusRacha = racha > 0 ? calcularBonusRacha(racha) : 0;

    let avistamiento = '❌ no reclamado';
    if (v2.avist_reclamado) {
        avistamiento = (v2.avist_pendiente > 0) ? '⏳ pendiente (necesitás 10 min en el chat)' : '✅ reclamado';
    }

    let faltan = '';
    if (postasActuales < 3) faltan = 'Faltan: ' + (3 - postasActuales) + ' posta' + (postasActuales === 2 ? '' : 's') + ' para completar el día';
    else faltan = '¡Día completo!';

    // Al usuario le mostramos los minutos topeados a 60 (el máximo que da postas).
    // Si tiene 24, ve 24. Si tiene 63, ve 60. Coherente con las postas mostradas.
    const minutosMostrar = Math.min(minutosActuales, 60);
    const _rangoObs = getRangoObservacion(user.observacion || 0, supObs);
    console.log('[OBSERVACION] ' + username + ' | min ' + minutosActuales + ' (postas ' + postasActuales + '/3) | pts_hoy ' + ptsHoy + ' | pend ' + ptsPendientes + ' | racha ' + racha + ' | avist_recl ' + (v2.avist_reclamado ? 'true' : 'false') + ' | rango ' + _rangoObs.nombre + '(' + (user.observacion || 0) + ') | F ' + getFactorRango(user.conquistador || 0));
    const msg = '📡 Haki de Observación\n' +
        '🚩 Postas hoy: ' + postasActuales + '/3 (' + minutosMostrar + ' min)\n' +
        '📈 Puntos hoy: +' + ptsHoy + (ptsPendientes > 0 ? ' (+' + ptsPendientes + ' pendiente)' : '') + '\n' +
        '🔥 Racha: ' + racha + ' día' + (racha === 1 ? '' : 's') + (bonusRacha > 0 ? ' (bonus +' + bonusRacha + ')' : '') + '\n' +
        '🔭 Avistamiento: ' + avistamiento + '\n' +
        '⏳ ' + faltan + '\n' +
        '👁️ Rango: ' + rango.emoji + ' ' + rango.nombre + ' (' + (user.observacion || 0) + ')';
    await sendWhisper(fromUserId, msg);
}

// ============================================
// RETAR
// ============================================
async function procesarColiseo(username, canal, channel) {
    const responder = (msg) => { try { client.say(channel, msg); } catch(e){} };
    const coliseoActual = await getColiseo(canal);
    // Solo consideramos "existe" si está en 'ventana'. Filas con estado viejo ('espera') se ignoran.
    const coliseoValido = (coliseoActual && coliseoActual.estado === 'ventana') ? coliseoActual : null;
    const esStreamer = (username === canal);
    const esDueñoGlobal = esDueño(username);
    const puedeAbrir = esStreamer || esDueñoGlobal;

    // ============================================
    // CASO A: ya hay coliseo en ventana abierta → INSCRIPCIÓN
    // ============================================
    if (coliseoValido) {
        const participantes = coliseoValido.participantes || [];
        if (participantes.find(p => p.username === username)) {
            responder('🏟️ @' + username + ' ya estás inscripto.');
            return;
        }
        if (participantes.length >= COLISEO_TOPE_PARTICIPANTES) {
            responder('🏟️ El Coliseo está lleno (' + COLISEO_TOPE_PARTICIPANTES + '/' + COLISEO_TOPE_PARTICIPANTES + ').');
            return;
        }
        const user = await getUsuario(username);
        if (!user) return;
        const otroColiseo = await usuarioEnColiseo(username);
        if (otroColiseo && otroColiseo !== canal) {
            responder('🏟️ @' + username + ' ya estás en un coliseo en otro canal.');
            return;
        }
        if (user.evento_duelo_estado === 'pendiente') {
            responder('🏟️ @' + username + ' tenés un duelo pendiente. Resolvelo antes.');
            return;
        }
        if ((user.conquistador || 0) < COLISEO_CONQ_MINIMO) {
            responder('🏟️ @' + username + ' necesitás al menos ' + COLISEO_CONQ_MINIMO + ' de Conquistador.');
            return;
        }
        if ((user.coliseos_hoy || 0) >= DUELO_LIMITE_DIARIO) {
            responder('🏟️ @' + username + ' ya usaste tus 10 duelos/coliseos de hoy.');
            return;
        }
        const pcf = await calcularPCFUsuario(user);
        if (pcf <= 0) {
            responder('🏟️ @' + username + ' necesitás ganar experiencia antes de entrar.');
            return;
        }
        // Inscribir SIN incrementar coliseos_hoy (se incrementa al resolver)
        const participantesNuevos = [...participantes, { username, pcf }];
        await guardarColiseo(canal, { participantes: participantesNuevos });
        await updateUsuario(username, { coliseo_canal: canal });
        let avisoCol = '';
        if (!user.aviso_requisito_mostrado) {
            avisoCol = ' ⚠️ Si no usás !explorar (por susurro o chat del bot), no vas a poder hacer duelos ni coliseos en un futuro.';
            await updateUsuario(username, { aviso_requisito_mostrado: true });
        }
        responder('✅ @' + username + ' inscripto.' + avisoCol);
        // Si llegamos al tope, cerrar inmediatamente
        if (participantesNuevos.length >= COLISEO_TOPE_PARTICIPANTES) {
            client.say(channel, '🔔 ' + COLISEO_TOPE_PARTICIPANTES + '/' + COLISEO_TOPE_PARTICIPANTES + '. El Coliseo cierra la inscripción.');
            const coliseoRefreshed = await getColiseo(canal);
            if (coliseoRefreshed) await cerrarVentanaColiseo(coliseoRefreshed);
        }
        return;
    }

    // ============================================
    // CASO B: no hay coliseo válido → ABRIR VENTANA
    // ============================================
    if (!puedeAbrir) return; // solo streamer del canal o dueño global
    const user = await getUsuario(username);
    if (!user) return;
    if (user.evento_duelo_estado === 'pendiente') {
        responder('🏟️ @' + username + ' tenés un duelo pendiente.');
        return;
    }
    if ((user.conquistador || 0) < COLISEO_CONQ_MINIMO) {
        responder('🏟️ @' + username + ' necesitás al menos ' + COLISEO_CONQ_MINIMO + ' de Conquistador.');
        return;
    }
    if ((user.coliseos_hoy || 0) >= DUELO_LIMITE_DIARIO) {
        responder('🏟️ @' + username + ' ya usaste tus 10 duelos/coliseos de hoy.');
        return;
    }
    const pcf = await calcularPCFUsuario(user);
    if (pcf <= 0) {
        responder('🏟️ @' + username + ' necesitás ganar experiencia antes de entrar.');
        return;
    }
    // Crear ventana nueva (con el que abre como primer participante)
    const ahora = Date.now();
    const ventanaFin = new Date(ahora + COLISEO_VENTANA_MINUTOS * 60000).toISOString();
    await guardarColiseo(canal, {
        estado: 'ventana',
        participantes: [{ username, pcf }],
        ventana_inicio: new Date(ahora).toISOString(),
        ventana_fin: ventanaFin
    });
    await updateUsuario(username, { coliseo_canal: canal });
    client.say(channel, '🏟️ ¡Se abrieron las puertas del Coliseo! ' + COLISEO_VENTANA_MINUTOS + ' minutos para entrar con !coliseo. Requisito: tener mínimo ' + COLISEO_CONQ_MINIMO + ' de Conq.');
    if (!user.aviso_requisito_mostrado) {
        client.say(channel, '@' + username + ' ⚠️ Si no usás !explorar (por susurro o chat del bot), no vas a poder hacer duelos ni coliseos en un futuro.');
        await updateUsuario(username, { aviso_requisito_mostrado: true });
    }
    return;
}

async function procesarOp(username, displayName, fromUserId, esSusurro, chatChannel) {
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, msg);
    };
    const user = await getUsuario(username);
    if (!user) return;
    const ahora = Date.now();
    const ultimoTs = user.ultimo_op_timestamp ? new Date(user.ultimo_op_timestamp).getTime() : 0;
    const tiempoRestante = (10 * 60 * 1000) - (ahora - ultimoTs);
    if (tiempoRestante > 0) {
        const min = Math.floor(tiempoRestante / 60000);
        const seg = Math.floor((tiempoRestante % 60000) / 1000);
        await responder('⏳ Faltan ' + min + 'm ' + seg + 's para !op.');
        return;
    }
    let msgPenalizacion = null;
    const hoy = getFechaHoy();
    // Si el scheduler ya aplicó la penalización, solo mostramos el aviso
    if (user.op_delta_pendiente !== null && user.op_delta_pendiente !== undefined) {
        const deltaPend = user.op_delta_pendiente;
        if (deltaPend !== 0) {
            msgPenalizacion = '💤 Descuidaste tu entrenamiento. -' + Math.abs(deltaPend) + ' Armadura.';
        }
        await updateUsuario(username, { op_delta_pendiente: null });
        user.op_delta_pendiente = null;
    }
    const ultimoDia = user.ultimo_op_fecha || null;
    if (ultimoDia !== hoy) {
        const usosAyer = user.op_usos_hoy || 0;
        const usosFaltantes = 3 - usosAyer;
        if (usosFaltantes > 0 && ultimoDia !== null) {
            let arm = user.armadura || 0;
            let delta = 0;
            if (usosAyer === 0 && arm < 20) { delta = -1; arm = Math.max(arm - 1, 0); }
            else {
                for (let i = 0; i < usosFaltantes; i++) {
                    const rango = getRangoArmadura(arm);
                    const int = getIntervaloTirada(rango.nombre);
                    const peor = Math.min(int.min, int.max);
                    delta += peor;
                    arm = Math.max(arm + peor, 0);
                }
            }
            if (delta !== 0) msgPenalizacion = '💤 Descuidaste tu entrenamiento. -' + Math.abs(delta) + ' Armadura.';
            chequearHakiCambio('armadura', user.armadura, arm);
            await updateUsuario(username, { armadura: arm, op_usos_hoy: 0, ultimo_op_fecha: hoy, racha_ops: 0 });
            user.armadura = arm;
            user.op_usos_hoy = 0;
            user.ultimo_op_fecha = hoy;
            user.racha_ops = 0;
        } else {
            await updateUsuario(username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
            user.op_usos_hoy = 0;
            user.ultimo_op_fecha = hoy;
        }
    }
    if ((user.op_usos_hoy || 0) >= 3) { await responder('Límite diario alcanzado.'); return; }
    const armActual = user.armadura || 0;
    const eraSupremo = await esSupremoArmadura(username);
    const rangoActual = getRangoArmadura(armActual, eraSupremo);
    const intervalo = getIntervaloTirada(rangoActual.nombre);
    const delta = tiradaAleatoria(intervalo.min, intervalo.max);
    const nuevaArm = Math.max(armActual + delta, 0);
    const nuevosUsos = (user.op_usos_hoy || 0) + 1;
    const updateData = {
        armadura: nuevaArm, op_usos_hoy: nuevosUsos,
        ultimo_op_fecha: hoy, ultimo_op_timestamp: new Date().toISOString()
    };
    const mensajesExtra = [];
    if (nuevosUsos === 3) {
        const bonusDiario = getBonusDiario(rangoActual.nombre);
        mensajesExtra.push('🔥 Diario: +' + bonusDiario);
        const ultimoDiaRacha = user.ultimo_dia_racha || null;
        let rachaActual = user.racha_ops || 0;
        rachaActual = (ultimoDiaRacha === getFechaAyer()) ? rachaActual + 1 : 1;
        const bonusRacha = getBonusRachaOp(rachaActual);
        mensajesExtra.push('🔥 Racha ' + rachaActual + 'd: +' + bonusRacha);
        updateData.armadura = nuevaArm + bonusDiario + bonusRacha;
        updateData.racha_ops = rachaActual;
        updateData.ultimo_dia_racha = hoy;
    }
    chequearHakiCambio('armadura', user.armadura, updateData.armadura);
    await updateUsuario(username, updateData);
    const ahoraSupremo = await esSupremoArmadura(username);
    const rangoFinal = getRangoArmadura(updateData.armadura, ahoraSupremo);
    const texto = getTextoResultadoOp(rangoFinal.nombre, delta);
    let respuesta = texto + ' ' + (delta > 0 ? '+' : '') + delta + ' Armadura ' + rangoFinal.emoji;
    if (!esSusurro) respuesta = '@' + displayName + ' ' + respuesta;
    const rangoNotifArm = (user.armadura_rango_notificado === null || user.armadura_rango_notificado === undefined) ? -1 : user.armadura_rango_notificado;
    if (rangoFinal.idx > rangoNotifArm) {
        const msg = MENSAJES_RANGO_ARMADURA[rangoFinal.nombre];
        if (msg) respuesta += ' | ' + msg;
        await updateUsuario(username, { armadura_rango_notificado: rangoFinal.idx });
        console.log('⬆️ Rango: ' + username + ' → Armadura ' + rangoFinal.nombre);
    }
    if (mensajesExtra.length > 0) respuesta += ' | ' + mensajesExtra.join(' | ');
    if (msgPenalizacion) respuesta = msgPenalizacion + ' | ' + respuesta;
    await responder(respuesta);
}

async function procesarRetar(username, targetRaw, fromUserId, esSusurro, chatChannel) {
    const target = targetRaw.replace('@', '').toLowerCase();
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, '@' + username + ' ' + msg);
    };
    if (target === username) { await responder('No podés retarte a vos mismo.'); return; }
    const targetUser = await getUsuario(target, false);
    if (!targetUser) { await responder('@' + target + ' no existe. Verificá el nombre.'); return; }
    const user = await getUsuario(username);
    if (!user) return;
    if (user.evento_duelo_estado === 'pendiente') {
        const otro = user.evento_duelo_retador === username ? user.evento_duelo_retado : user.evento_duelo_retador;
        await responder('Ya tenés un duelo pendiente con @' + otro + '.'); return;
    }
    if (user.evento_explorar_estado === 'pendiente') {
        await responder('Tenés una exploración pendiente. Resolvela antes.'); return;
    }
    if (user.ultimo_duelo_timestamp) {
        const diff = Date.now() - new Date(user.ultimo_duelo_timestamp).getTime();
        if (diff < DUELO_COOLDOWN_MS) { await responder('Esperá ' + Math.ceil((DUELO_COOLDOWN_MS - diff) / 60000) + ' min.'); return; }
    }
    if ((await contarDuelosHoy(username)) >= DUELO_LIMITE_DIARIO) { await responder('Ya usaste tus 10 duelos de hoy.'); return; }
    if ((await contarDuelosHoyEntre(username, target)) >= DUELO_LIMITE_PAREJA) { await responder('Ya se enfrentaron 3 veces hoy.'); return; }
    if (await fueRechazadoHoy(username, target)) { await responder('@' + target + ' ya te rechazó hoy.'); return; }
    if (targetUser.evento_duelo_estado === 'pendiente') { await responder('@' + target + ' ya tiene duelo pendiente.'); return; }
    if (targetUser.evento_explorar_estado === 'pendiente') {
        await responder('@' + target + ' está en medio de una exploración.'); return;
    }
    const pcfRetador = await calcularPCFUsuario(user);
    const pcfRetado = await calcularPCFUsuario(targetUser);
    const rProb = pcfRetado / pcfRetador;
    const probRetador = (rProb === 0) ? 1 : (rProb === Infinity || isNaN(rProb) ? 0 : 1 / (1 + Math.pow(rProb, EXP_PROB)));
    if (probRetador < 0.05) {
        await responder('⚔️ No podés retar a @' + target + '. Respetá los rangos.');
        return;
    }
    if (probRetador > 0.80) {
        await responder('⚔️ @' + target + ' no es rival para vos. Buscate a alguien de tu nivel, ¿o tenés miedo de perder?');
        return;
    }
    const expiraISO = new Date(Date.now() + DUELO_TIMEOUT_MS).toISOString();
    const canalReto = esSusurro ? 'op_d_bot' : chatChannel.replace('#', '');
    const evento = {
        evento_duelo_estado: 'pendiente',
        evento_duelo_retador: username,
        evento_duelo_retado: target,
        evento_duelo_pcf_retador: pcfRetador,
        evento_duelo_expira: expiraISO,
        evento_duelo_canal: canalReto
    };
    await updateUsuario(username, evento);
    await updateUsuario(target, evento);
    let avisoRetador = '';
    if (!user.aviso_requisito_mostrado) {
        avisoRetador = ' ⚠️ Si no usás !explorar (por susurro o chat del bot), no vas a poder hacer duelos ni coliseos en un futuro.';
        await updateUsuario(username, { aviso_requisito_mostrado: true });
    }
    if (!esSusurro) {
        client.say(chatChannel, '⚔️ @' + target + ', @' + username + ' te ha retado a un duelo.' + avisoRetador);
    }
    await notificar(target, targetUser.twitch_user_id, '⚔️ @' + username + ' te ha retado a un duelo. Tenés 2 minutos para responder con !aceptarduelo o !rechazarduelo.');
    if (esSusurro) await sendWhisper(fromUserId, '⚔️ Reto enviado a @' + target + '.' + avisoRetador);
}
// Calaveras para evento de fruta (calculadas al momento de mostrar)
async function getCalaverasEventoFruta(user, frutaData) {
    const poderFrutaUsuario = (frutaData && frutaData.poder_fruta) ? frutaData.poder_fruta : 0;
    const nombreSombra = (frutaData && frutaData.sombra) ? frutaData.sombra : null;
    const supArm = await esSupremoArmadura(user.username);
    const supObs = await esSupremoObservacion(user.username);
    const supConq = await esSupremoConquistador(user.username);
    const poderUsuario = poderFrutaUsuario
        + calcularAporteArmadura(user.armadura || 0, supArm)
        + calcularAporteObservacion(user.observacion || 0, supObs)
        + calcularAporteConquistador(user.conquistador || 0, supConq);
    let poderEnemigo = 80;
    if (nombreSombra) {
        const { data: npc } = await supabase.from('npcs').select('pcf_final, pcf_calculado').eq('nombre', nombreSombra).maybeSingle();
        poderEnemigo = (npc && (npc.pcf_final || npc.pcf_calculado)) || 80;
    } else poderEnemigo = 20 + (user.evento_fruta_nivel || 4) * 15;
    const r = poderEnemigo / poderUsuario;
    const prob = 1 / (1 + Math.pow(r, EXP_PROB));
    return getCalaverasPorProb(prob);
}

// ============================================
// ACEPTAR / RECHAZAR DUELO
// ============================================
async function procesarAceptarDuelo(username, fromUserId, esSusurro, chatChannel) {
    const user = await getUsuario(username);
    if (!user || user.evento_duelo_estado !== 'pendiente') {
        if (esSusurro) await sendWhisper(fromUserId, 'No tenés duelo pendiente.');
        else client.say(chatChannel, '@' + username + ' No tenés duelo pendiente.');
        return;
    }
    if (user.evento_duelo_retado !== username) {
        if (esSusurro) await sendWhisper(fromUserId, 'No sos el retado.');
        return;
    }
    if (new Date(user.evento_duelo_expira) < new Date()) {
        if (esSusurro) await sendWhisper(fromUserId, 'El duelo ya expiró.');
        else client.say(chatChannel, '@' + username + ' El duelo ya expiró.');
        return;
    }
    const retador = user.evento_duelo_retador;
    const retado = user.evento_duelo_retado;
    const pcfRetador = user.evento_duelo_pcf_retador;
    const canalDuelo = user.evento_duelo_canal;
    const retadorUser = await getUsuario(retador);
    const retadoUser = await getUsuario(retado);
    if (!retadorUser || !retadoUser) {
        await limpiarEventoDuelo(retador); await limpiarEventoDuelo(retado);
        if (esSusurro) await sendWhisper(fromUserId, 'Error.');
        return;
    }
    const pcfRetado = await calcularPCFUsuario(retadoUser);
    const r = pcfRetado / pcfRetador;
    const probRetador = 1 / (1 + Math.pow(r, EXP_PROB));
    const res = resolverDuelo(probRetador, retador, retado);
    const ganador = res.ganador;
    const empate = res.empate;
    let monto = 0;
    let conqCambio = 0;
    if (!empate) {
        // Conq según probabilidad del ganador
        const winnerProb = (ganador === retador) ? probRetador : (1 - probRetador);
        if (winnerProb < 0.35) conqCambio = 3;
        else if (winnerProb > 0.65) conqCambio = 1;
        else conqCambio = 2;
        
        const perdedorUser = ganador === retador ? retadoUser : retadorUser;
        const ganadorEsRetador = (ganador === retador);
        // Recompensas reales con tope delta
        const recRet = await getRecompensaReal(retadorUser);
        const recRetado = await getRecompensaReal(retadoUser);
        const deltaPerd = perdedorUser.recompensa_delta || 0;
        monto = calcularMontoDuelo(recRet, recRetado, pcfRetador, pcfRetado, deltaPerd, ganadorEsRetador);
        // Cuánto pierde realmente el perdedor (nunca más de lo que tiene, mínimo 0)
        const perdidaReal = Math.min(monto, Math.max(0, deltaPerd));
        if (ganadorEsRetador) {
            chequearHakiCambio('conquistador', retadorUser.conquistador, (retadorUser.conquistador || 0) + conqCambio);
            chequearHakiCambio('conquistador', retadoUser.conquistador, Math.max((retadoUser.conquistador || 0) - conqCambio, 0));
            await updateUsuario(retador, {
                recompensa_delta: (retadorUser.recompensa_delta || 0) + monto,
                conquistador: (retadorUser.conquistador || 0) + conqCambio
            });
            await updateUsuario(retado, {
                recompensa_delta: (retadoUser.recompensa_delta || 0) - perdidaReal,
                conquistador: Math.max((retadoUser.conquistador || 0) - conqCambio, 0)
            });
        } else {
            chequearHakiCambio('conquistador', retadoUser.conquistador, (retadoUser.conquistador || 0) + conqCambio);
            chequearHakiCambio('conquistador', retadorUser.conquistador, Math.max((retadorUser.conquistador || 0) - conqCambio, 0));
            await updateUsuario(retado, {
                recompensa_delta: (retadoUser.recompensa_delta || 0) + monto,
                conquistador: (retadoUser.conquistador || 0) + conqCambio
            });
            await updateUsuario(retador, {
                recompensa_delta: (retadorUser.recompensa_delta || 0) - perdidaReal,
                conquistador: Math.max((retadorUser.conquistador || 0) - conqCambio, 0)
            });
        }
    }
    const situacion = getSituacionDuelo(ganador, empate, retador, retado, probRetador);
    const estadoDuelo = empate ? 'empate' : 'finalizado';
    await crearDuelo({
        retador, retado, estado: estadoDuelo,
        pcf_retador: pcfRetador, pcf_retado: pcfRetado,
        prob_retador: parseFloat(probRetador.toFixed(4)),
        ganador, monto,
        delta_retador: Math.round(retadorUser.recompensa_delta || 0),
        delta_retado: Math.round(retadoUser.recompensa_delta || 0),
        canal: 'op_d_bot'
    });
    await limpiarEventoDuelo(retador);
    await limpiarEventoDuelo(retado);
    const ahoraISO = new Date().toISOString();
    await updateUsuario(retador, { ultimo_duelo_timestamp: ahoraISO });
    await updateUsuario(retado, { ultimo_duelo_timestamp: ahoraISO });
    const hakiRetLog = await formatearHakiLog(retadorUser);
    const hakiRetadoLog = await formatearHakiLog(retadoUser);
    console.log('[DUELO] ' + retador + ' vs ' + retado + ' | PCF ' + pcfRetador + ' vs ' + pcfRetado + ' | Haki: ' + hakiRetLog + ' vs ' + hakiRetadoLog + ' | ' + (empate ? 'EMPATE' : 'Ganador: ' + ganador) + ' | Monto: ' + monto);
    const textoBase = await getTextoDuelo(situacion);
    const perdedor = empate ? '' : (ganador === retador ? retado : retador);
    let texto = aplicarPlaceholders(textoBase, {
        retador, retado, ganador: ganador || '', perdedor,
        monto: monto > 0 ? formatBerries(monto) : '0'
    });
    if (!empate && conqCambio > 0) {
        const conqStr = '+' + conqCambio + ' Conq | ';
        const before = texto;
        texto = texto.replace(/Su\s+recompensa/i, conqStr + 'Su recompensa');
        if (texto === before) {
            texto = texto + ' | +' + conqCambio + ' Conq';
        }
    }
    let avisoRetado = '';
    if (!retadoUser.aviso_requisito_mostrado) {
        avisoRetado = ' ⚠️ Si no usás !explorar (por susurro o chat del bot), no vas a poder hacer duelos ni coliseos en un futuro.';
        await updateUsuario(retado, { aviso_requisito_mostrado: true });
    }
    if (canalDuelo && canalDuelo !== 'op_d_bot') client.say(canalDuelo, texto);
    else client.say('op_d_bot', texto);
    if (avisoRetado && !esSusurro) {
        const canalAviso = (canalDuelo && canalDuelo !== 'op_d_bot') ? canalDuelo : 'op_d_bot';
        client.say(canalAviso, '@' + retado + avisoRetado);
    }
    await notificar(retador, retadorUser.twitch_user_id, '⚔️ ' + texto);
    await notificar(retado, retadoUser.twitch_user_id, '⚔️ ' + texto);
    if (esSusurro) await sendWhisper(fromUserId, '⚔️ Duelo resuelto. ' + texto + avisoRetado);
}

async function procesarRechazarDuelo(username, fromUserId, esSusurro, chatChannel) {
    const user = await getUsuario(username);
    if (!user || user.evento_duelo_estado !== 'pendiente') {
        if (esSusurro) await sendWhisper(fromUserId, 'No tenés duelo pendiente.');
        else client.say(chatChannel, '@' + username + ' No tenés duelo pendiente.');
        return;
    }
    if (user.evento_duelo_retado !== username) {
        if (esSusurro) await sendWhisper(fromUserId, 'No sos el retado.');
        return;
    }
    const retador = user.evento_duelo_retador;
    const retado = user.evento_duelo_retado;
    const pcfRetador = user.evento_duelo_pcf_retador;
    const retadorUser = await getUsuario(retador);
    const retadoUser = await getUsuario(retado);
    await crearDuelo({
        retador, retado, estado: 'rechazado',
        pcf_retador: pcfRetador,
        pcf_retado: retadoUser ? await calcularPCFUsuario(retadoUser) : null,
        prob_retador: null, ganador: null, monto: 0,
        delta_retador: retadorUser ? Math.round(retadorUser.recompensa_delta || 0) : 0,
        delta_retado: retadoUser ? Math.round(retadoUser.recompensa_delta || 0) : 0,
        canal: 'op_d_bot'
    });
    await limpiarEventoDuelo(retador);
    await limpiarEventoDuelo(retado);
    const ahoraISO = new Date().toISOString();
    await updateUsuario(retador, { ultimo_duelo_timestamp: ahoraISO });
    await updateUsuario(retado, { ultimo_duelo_timestamp: ahoraISO });
    console.log('⚔️ Duelo rechazado: ' + retador + ' vs ' + retado);
    if (esSusurro) await sendWhisper(fromUserId, 'Rechazaste el duelo.');
    else client.say(chatChannel, '@' + username + ' Rechazaste el duelo.');
    if (retadorUser) {
        const t = await getTextoDuelo('rechazo');
        await notificar(retador, retadorUser.twitch_user_id, '❌ ' + aplicarPlaceholders(t, { retador, retado, monto: '0' }));
    }
}

// ============================================
// COMANDOS DE CHAT
// ============================================
client.on('message', async (channel, tags, message, self) => {
    try {
        await procesarMensajeChat(channel, tags, message, self);
    } catch (err) {
        console.error('❌ Error en handler de chat:', err);
    }
});

async function procesarMensajeChat(channel, tags, message, self) {
    if (self) return;
    if (channel.startsWith('##')) return;
    if (tags['message-type'] === 'whisper') return;

    const args = message.trim().split(' ');
    const command = normalizarComando(args[0]);
    const username = tags.username.toLowerCase();
    const twitchUserId = tags['user-id'];
    const canal = channel.replace('#', '').toLowerCase();

    if (!command.startsWith('!')) return;

    // Modo mantenimiento: solo los comandos de deploy confirm funcionan
    if (mantenimientoActivo && command !== '!deploylisto' && command !== '!deplis') return;

    // Predeploy: bloquea duelos y coliseos
    if (predeployActivo && (command === '!retar' || command === '!duelo' || command === '!coliseo')) {
        client.say(channel, '@' + tags.username + ' ⏳ El bot se prepara para mantenimiento. Esperá un momento.');
        return;
    }

    const canalDb = await getCanal(canal);
    const botActivo = canalDb ? canalDb.bot_activo : true;

    if (!botActivo && command !== '!onop') return;

    // Canal live: si tiene lurk_activo y no está live, ignorar todo
    if (!(await canalEstaActivo(canal, canalDb))) return;

    // !onop / !offop
    if (command === '!onop' || command === '!offop') {
        if (!esModOCaster(tags)) return;
        if (cooldownsOnOff[canal] && Date.now() - cooldownsOnOff[canal] < 60 * 1000) {
            client.say(channel, '⏳ Esperá 1 minuto antes de volver a cambiar el estado del bot.');
            return;
        }
        cooldownsOnOff[canal] = Date.now();
        const nuevoEstado = (command === '!onop');
        await updateCanal(canal, { bot_activo: nuevoEstado, fecha_ultimo_cambio: new Date().toISOString() });
        if (nuevoEstado) {
            console.log('🟢 ' + username + ' reactivó el bot en ' + canal);
            client.say(channel, '🟢 Bot reactivado en este canal.');
        } else {
            console.log('🔴 ' + username + ' desactivó el bot en ' + canal);
            client.say(channel, '🔴 Bot desactivado en este canal. Usá !onop si querés volver a activarlo.');
        }
        return;
    }
    if (COMANDOS_DEL_BOT.has(command)) {
        console.log('💬 [' + canal + '] ' + username + ': ' + message);
    }

    // Solo crear usuarios para comandos que realmente los usan.
    // Cualquier otro !comando (por ej. para otros bots) NO toca la DB.
    const usaUsuario = COMANDOS_CON_USUARIO.includes(command);

    if (usaUsuario && twitchUserId) {
        try {
            const u = await getUsuario(username);
            if (u && u.twitch_user_id !== twitchUserId) {
                await updateUsuario(username, { twitch_user_id: twitchUserId });
            }
        } catch (e) { console.error('Error guardando user_id:', e); }
    }

    if (command === '!ayudaop' && canal !== 'op_d_bot') {
        client.say(channel, '👈 Mandame !ayudaop por susurro');
        return;
    }
    // !setepisodio
    if (command === '!setepisodio') {
        const esDueñoGlobal = esDueño(username);
        const esDueñoCanal = (username === canal);
        const esMod = tags.mod === true || (tags.badges && tags.badges.broadcaster === '1');
        if (!esDueñoGlobal && !esDueñoCanal && !esMod) return;
        const canalDbSetEp = canalDb;
        if (!canalDbSetEp) return;
        if (!args[1]) {
            client.say(channel, '@' + tags.username + ' Filtro actual: ' + (canalDbSetEp.episodio_filtro || 'sin filtro'));
            return;
        }
        const valor = args[1].toLowerCase();
        if (valor !== 'anime' && valor !== 'manga' && isNaN(parseInt(valor))) {
            client.say(channel, '@' + tags.username + ' Valor inválido. Usá número, "anime" o "manga".');
            return;
        }
        await updateCanal(canal, { episodio_filtro: valor });
        console.log('📺 Filtro actualizado: ' + canal + ' → ' + valor);
        client.say(channel, '@' + tags.username + ' Filtro actualizado a: ' + valor);
        return;
    }

    if (command === '!susurrame') {
        await procesarSusurrame(username, twitchUserId, channel);
        return;
    }

    if (usaUsuario) {
        try {
        // 1. Notificación pendiente del scheduler (evita reaplicar)
        const userP = await getUsuario(username);
        if (userP && userP.explorar_penal_pendiente) {
            const p = userP.explorar_penal_pendiente;
            let msgPen = '💤 No exploraste por ' + p.dias + ' día(s).';
            if (p.perdConq > 0) msgPen += ' Perdiste ' + p.perdConq + ' Conq y $' + p.perdBerries.toLocaleString('es-AR') + '.';
            else msgPen += ' Perdiste $' + p.perdBerries.toLocaleString('es-AR') + '.';
            client.say(channel, '@' + tags.username + ' ' + msgPen);
            await updateUsuario(username, { explorar_penal_pendiente: null });
        } else {
            // 2. Fallback: chequeo in-line (por si el scheduler no corrió)
            const penal = await verificarPenalizacionExplorar(username);
            if (penal) {
                let msgPen = '💤 No exploraste por ' + penal.dias + ' día(s).';
                if (penal.perdConq > 0) msgPen += ' Perdiste ' + penal.perdConq + ' Conq y $' + penal.perdBerries.toLocaleString('es-AR') + '.';
                else msgPen += ' Perdiste $' + penal.perdBerries.toLocaleString('es-AR') + '.';
                client.say(channel, '@' + tags.username + ' ' + msgPen);
            }
        }
        } catch (err) { console.error('Error penal:', err); }
    }

    // Si el usuario perdió una fruta pendiente, avisarle y limpiar la marca.
    // Para !fruta NO se cancela (se aplica el premio consuelo en ese comando).
    const COMANDOS_FRUTA_PERDIDA = ['!comer', '!rechazar', '!si', '!no', '!pelear', '!huir', '!frutapendiente', '!fruta'];
    if (COMANDOS_FRUTA_PERDIDA.includes(command)) {
        const userFP = await getUsuario(username);
        if (userFP && userFP.fruta_perdida_por) {
            const perdidaPor = userFP.fruta_perdida_por;
            let msgFP;
            if (command === '!rechazar' || command === '!no' || command === '!huir') {
                msgFP = '¡Que bueno... no había fruta! @' + perdidaPor + ' ya le hizo la digestión y todo';
            } else {
                msgFP = '¿Y tu fruta? ¿Habría jurado que había una fruta aquí... Nooo, pestañaste, y @' + perdidaPor + ' te la primereó';
            }
            if (command === '!frutapendiente') {
                msgFP += ' (Tenés una tirada extra garantizada de una fruta con poder similar)';
            }
            client.say(channel, '@' + tags.username + ' ' + msgFP);
            await updateUsuario(username, { fruta_perdida_por: null });
            if (command !== '!fruta') return;
        }
    }

    // En op_d_bot, comandos de susurro funcionan también por chat con @username adelante.
    if (canal === 'op_d_bot' && COMANDOS_SUSURRO_EN_OP_D_BOT.includes(command)) {
        if (twitchUserId && await usuarioExiste(username)) {
            const u = await getUsuario(username);
            if (u && u.twitch_user_id !== twitchUserId) {
                await updateUsuario(username, { twitch_user_id: twitchUserId });
            }
        }
        await contextoOpDBot.run({ username: tags.username, fromUserId: twitchUserId }, async () => {
            const fakeEvent = {
                from_user_id: twitchUserId,
                from_user_login: tags.username,
                whisper: { text: message }
            };
            await handleWhisper(fakeEvent);
        });
        return;
    }

    // Bloqueo por coliseo activo (solo si la ventana está abierta)
    const COMANDOS_BLOQUEADOS_COLISEO = [
        '!op', '!fruta', '!comer', '!pelear', '!retar', '!aceptarduelo',
        '!explorar', '!facil', '!medio', '!dificil', '!continuar', '!retroceder',
        '!combatir', '!retirarse', '!exploracionpendiente'
    ];
    if (COMANDOS_BLOQUEADOS_COLISEO.includes(command)) {
        const userCol = await getUsuario(username);
        if (userCol && userCol.coliseo_canal) {
            const col = await getColiseo(userCol.coliseo_canal);
            if (col && col.estado === 'ventana') {
                client.say(channel, '@' + tags.username + ' Estás en un Coliseo activo. Esperá a que termine.');
                return;
            }
        }
    }

    const comandosBloqueados = ['!op', '!fruta', '!comer', '!pelear'];
    if (comandosBloqueados.includes(command)) {
        const u = await getUsuario(username);
        if (u && u.evento_duelo_estado === 'pendiente') {
            const otro = u.evento_duelo_retador === username ? u.evento_duelo_retado : u.evento_duelo_retador;
            client.say(channel, '@' + tags.username + ' Tenés un duelo pendiente con @' + otro + '. Resolvelo antes.');
            return;
        }
        if (u && u.evento_explorar_estado === 'pendiente') {
            if (command === '!op') client.say(channel, '@' + tags.username + ' Terminá tu exploración primero.');
            else if (command === '!fruta') client.say(channel, '@' + tags.username + ' Hay una sombra esperando tu decisión.');
            else client.say(channel, '@' + tags.username + ' Concentrate en la pelea pendiente.');
            return;
        }
    }

    if (command === '!retar') {
        if (args.length < 2) { client.say(channel, '@' + tags.username + ' Uso: !retar @usuario'); return; }
        await procesarRetar(username, args[1], null, false, channel);
        return;
    }
    if (command === '!aceptarduelo') { await procesarAceptarDuelo(username, null, false, channel); return; }
    if (command === '!rechazarduelo') { await procesarRechazarDuelo(username, null, false, channel); return; }

    if (command === '!historial') {
        if (!args[1]) { client.say(channel, '@' + tags.username + ' Uso: !historial @usuario'); return; }
        const target = args[1].replace('@', '').toLowerCase();
        if (target === username) { client.say(channel, '@' + tags.username + ' No podés compararte con vos mismo.'); return; }
        const key = 'hist_' + username;
        if (cooldowns[key] && Date.now() - cooldowns[key] < 10000) {
            client.say(channel, '@' + tags.username + ' Esperá unos segundos.'); return;
        }
        cooldowns[key] = Date.now();
        const h = await getHistorialH2H(username, target);
        if (h.total === 0) { client.say(channel, '@' + tags.username + ' Nunca te enfrentaste a @' + target + '.'); return; }
        const netoTxt = h.neto > 0 ? 'Le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'Te ganó $' + formatBerries(Math.abs(h.neto)) : 'Están a mano';
        client.say(channel, '📊 @' + username + ' vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }

    if (command === '!coliseo') {
        await procesarColiseo(username, canal, channel);
        return;
    }

    if (command === '!infoop') {
        if (args[1]) { client.say(channel, '@' + tags.username + ' Por susurro, máquina 📩'); return; }
        const infoopKey = 'infoop_' + username;
        if (cooldowns[infoopKey] && Date.now() - cooldowns[infoopKey] < 60000) {
            client.say(channel, '@' + tags.username + ' ⏳ Esperá un ratito crack, cuánto te creés que cambió?');
            return;
        }
        cooldowns[infoopKey] = Date.now();
        const user = await getUsuario(username);
        if (!user) { client.say(channel, '@' + tags.username + ' Error.'); return; }
        const supArm = await esSupremoArmadura(username);
        const supObs = await esSupremoObservacion(username);
        const supConq = await esSupremoConquistador(username);
        const recompensaReal = await getRecompensaReal(user);
        await updateUsuario(username, { recompensa_publica: recompensaReal });
        await actualizarRangosRecompensa(username);
        const rangoRec = await getRangoRecompensa(username);
        let frutaTexto = '🍎 Ninguna';
        const canalDbInfo = canalDb;
        const filtroInfo = canalDbInfo ? canalDbInfo.episodio_filtro : null;
        if (user.fruta) {
            const { data: f } = await supabase.from('frutas').select('emoji, episodio_anime').eq('nombre', user.fruta).single();
            if (f && !pasaFiltroEpisodio(f, filtroInfo)) {
                frutaTexto = '🍎 SPOILER';
            } else {
                frutaTexto = '🍎 ' + user.fruta + ' ' + ((f && f.emoji) || '');
            }
        }
        if (user.fruta_2) {
            const { data: f2 } = await supabase.from('frutas').select('emoji, episodio_anime').eq('nombre', user.fruta_2).single();
            if (f2 && !pasaFiltroEpisodio(f2, filtroInfo)) {
                frutaTexto += ' | 🍎 SPOILER';
            } else {
                frutaTexto += ' | 🍎 ' + user.fruta_2 + ' ' + ((f2 && f2.emoji) || '');
            }
        }
        const eArm = getRangoArmadura(user.armadura || 0, supArm).emoji;
        const eObs = getRangoObservacion(user.observacion || 0, supObs).emoji;
        const eConq = getRangoConquistador(user.conquistador || 0, supConq).emoji;
        let sufijoRango = '';
        if (rangoRec) sufijoRango = ' | ' + getEmojiRango(rangoRec) + ' ' + getNombreRango(rangoRec);
        client.say(channel, '@' + username + ' | ' + frutaTexto + ' | 🛡️:' + eArm + ' | 👁️:' + eObs + ' | ⚜️:' + eConq + ' | 💰 $' + recompensaReal.toLocaleString('es-AR') + sufijoRango);
        return;
    }

    if (command === '!op') {
        await procesarOp(username, tags.username, null, false, channel);
        return;
    }

    if (command === '!fruta') {
        await procesarFruta(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!frutapendiente') {
        await procesarFrutapendiente(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!si') {
        await procesarSi(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!no') {
        await procesarNo(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!pelear') {
        await procesarPelear(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!huir') {
        await procesarHuir(username, tags.username, null, false, channel, canalDb);
        return;
    }

    if (command === '!comer') {
        await procesarComer(username, tags.username, null, false, channel);
        return;
    }

    if (command === '!rechazar') {
        await procesarRechazar(username, tags.username, null, false, channel);
        return;
    }

    // ADMIN
    if (!esDueño(username)) return;
    const ADMIN_STATS = {
        sumar1: { campo: 'armadura', nombre: 'armadura', signo: 1 },
        sumar2: { campo: 'observacion', nombre: 'observación', signo: 1 },
        sumar3: { campo: 'conquistador', nombre: 'conquistador', signo: 1 },
        sumar4: { campo: 'recompensa_delta', nombre: 'recompensa delta', signo: 1, esBerries: true, permiteNegativo: true },
        restar1: { campo: 'armadura', nombre: 'armadura', signo: -1 },
        restar2: { campo: 'observacion', nombre: 'observación', signo: -1 },
        restar3: { campo: 'conquistador', nombre: 'conquistador', signo: -1 },
        restar4: { campo: 'recompensa_delta', nombre: 'recompensa delta', signo: -1, esBerries: true, permiteNegativo: true }
    };
    const cmdName = command.substring(1);
    if (ADMIN_STATS[cmdName]) {
        const info = ADMIN_STATS[cmdName];
        if (args.length < 3) return client.say(channel, '@' + tags.username + ' Uso: ' + command + ' @usuario cantidad');
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, '@' + tags.username + ' Cantidad inválida.');
        const user = await getUsuario(target, false);
        if (!user) return client.say(channel, '@' + tags.username + ' El usuario @' + target + ' no existe.');
        const actual = user[info.campo] || 0;
        let nuevo;
        if (info.signo > 0) {
            nuevo = actual + cantidad;
        } else if (info.permiteNegativo) {
            nuevo = actual - cantidad;
        } else {
            nuevo = Math.max(actual - cantidad, 0);
        }
        chequearHakiCambio(info.campo, actual, nuevo);
        await updateUsuario(target, { [info.campo]: nuevo });
        const accion = info.signo > 0 ? 'sumó' : 'restó';
        const accionMsg = info.signo > 0 ? 'Sumado' : 'Restado';
        const cantFmt = info.esBerries ? '$' + formatBerries(cantidad) : String(cantidad);
        const nuevoFmt = info.esBerries ? '$' + formatBerries(nuevo) : String(nuevo);
        console.log('🔧 Admin: ' + username + ' ' + accion + ' ' + cantidad + ' ' + info.nombre + ' a ' + target);
        client.say(channel, '@' + tags.username + ' ' + accionMsg + ' ' + cantFmt + ' ' + info.nombre + ' a @' + target + '. Ahora: ' + nuevoFmt);
        return;
    }
    if (command === '!quitarfruta') {
        if (args.length < 2) return client.say(channel, '@' + tags.username + ' Uso: !quitarfruta @usuario');
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target, false);
        if (!targetUser) return client.say(channel, '@' + tags.username + ' El usuario @' + target + ' no existe.');
        const frutasQuitadas = [targetUser.fruta, targetUser.fruta_2].filter(Boolean);
        await updateUsuario(target, { fruta: null, fruta_2: null, fruta_pendiente: null, yami_aviso_mostrado: false });
        if (frutasQuitadas.length > 0) {
            await supabase.from('frutas').update({ disponible: true }).in('nombre', frutasQuitadas);
        }
        console.log('🔧 Admin: ' + username + ' quitó fruta(s) a ' + target + ': ' + frutasQuitadas.join(', '));
        client.say(channel, '@' + tags.username + ' Fruta(s) quitada(s) a @' + target + '.'); return;
    }
}

// ============================================
// INICIALIZACIÓN
// ============================================
// ============================================
// ARRANQUE SECUENCIAL (uno tras otro, con pausas)
// ============================================
async function secuenciaArranque() {
    try {
        // 1. Estado de mantenimiento
        await cargarEstadoMantenimiento();
        await new Promise(r => setTimeout(r, 1500));

        // 2. Commit info
        await cargarCommitInfo();
        console.log('📦 Commit info cargado.');
        await new Promise(r => setTimeout(r, 1500));

        // 3. Estado NPC
        await cargarEstadoNpc();
        console.log('👁️ Estado NPC cargado.');
        programarProximoNpc();
        await new Promise(r => setTimeout(r, 1500));

        // 4. Supremos
        await actualizarTablaSupremos('armadura');
        await new Promise(r => setTimeout(r, 1000));
        await actualizarTablaSupremos('observacion');
        await new Promise(r => setTimeout(r, 1000));
        await actualizarTablaSupremos('conquistador');
        console.log('🏆 Tabla supremos inicializada.');
        await new Promise(r => setTimeout(r, 1500));

        // 5. Scan inicial de chatters
        for (const canal of CANALES_CON_LURK) {
            try { await escanearChatters(canal); }
            catch (e) { console.error('Error scan inicial ' + canal + ':', e); }
            await new Promise(r => setTimeout(r, 1000));
        }
        programarProximoScan();

        // 6. Susurro al dueño confirmando que arrancó
        const dueño = await getUsuario(DUEÑO);
        if (dueño && dueño.twitch_user_id) {
            const msg = mantenimientoActivo
                ? '✅ Bot arrancó en modo mantenimiento. Cuando quieras, tirá !deploylisto.'
                : '✅ Bot arrancó correctamente. Todo funcionando.';
            await sendWhisper(dueño.twitch_user_id, msg);
        }
        console.log('🚀 Secuencia de arranque completa.');
    } catch (e) {
        console.error('❌ Error en secuencia de arranque:', e);
    }
}

// Lanzar la secuencia al iniciar
secuenciaArranque();

// Schedulers periódicos (estos no arrancan con el boot, solo se registran)
setInterval(ejecutarTimeoutDuelos, 2 * 60 * 1000);
setInterval(lurkChequeoPeriodico, 10 * 60 * 1000);
setInterval(revisarColiseosExpirados, 2 * 60 * 1000);
setInterval(schedulerPenalizacionesDiarias, 60 * 60 * 1000);

// Limpieza de historial viejo (1 vez cada 6 horas)

// Scheduler de Supremos cada 30s
setInterval(async () => {
    try {
        for (const haki of ['armadura', 'observacion', 'conquistador']) {
            if (hakiSucia[haki]) {
                hakiSucia[haki] = false;
                await actualizarTablaSupremos(haki);
                console.log('🏆 Tabla supremos actualizada: ' + haki);
            }
        }
    } catch (e) { console.error('Error scheduler supremos:', e); }
}, 30 * 1000);

console.log('Bot escuchando...');