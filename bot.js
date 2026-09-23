require('dotenv').config();
const tmi = require('tmi.js');
const config = require('./config.js');
const {
    getUsuario, updateUsuario, supabase,
    getTextoDuelo, getTextoExplorar, getHistorialH2H,
    contarDuelosHoy, contarDuelosHoyEntre, fueRechazadoHoy,
    crearDuelo, limpiarEventoDuelo, tieneEventoPendiente,
    completoExplorarHoy
} = require('./database.js');

// ============================================
// CONSTANTES
// ============================================
const COOLDOWN_FRUTA = 60000;
const PROB_FRUTA = 100;
const DUEÑO = 'fan_d_larana';
const TWITCH_API_URL = 'https://api.twitch.tv/helix';
const GITHUB_REPO = 'onepiecebot/one_piece_bot';

const MODO_COOLDOWN = 'prueba';
const COOLDOWN_EXPLORAR_PRUEBA = 10 * 60 * 1000;
const COOLDOWN_EXPLORAR_PRODUCCION = 24 * 60 * 60 * 1000;

const DUELO_DELTA_MINIMO = 100000000;
const DUELO_COOLDOWN_MS = 10 * 60 * 1000;
const DUELO_LIMITE_DIARIO = 5;
const DUELO_LIMITE_PAREJA = 3;
const DUELO_TIMEOUT_MS = 2 * 60 * 1000;

const cooldowns = {};

// ============================================
// HELPERS GENERALES
// ============================================
function formatBerries(n) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
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
function getFechaOffset(diasOffset) {
    if (diasOffset === undefined) diasOffset = 0;
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
// RANGOS
// ============================================
function getRangoArmadura(puntos, esSupremo) {
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

function getEmojiRango(puntos, tipo, esSupremo) {
    tipo = tipo || 'armadura';
    if (tipo === 'conquistador') {
        if (puntos > 100) return '👑';
        if (puntos >= 95) return '🔥';
        if (puntos >= 80) return '💪';
        if (puntos >= 60) return '💡';
        return '❌';
    }
    if (tipo === 'armadura' && esSupremo) return '👑';
    if (puntos >= 100) return '👑';
    if (puntos >= 80) return '🔥';
    if (puntos >= 50) return '💪';
    if (puntos >= 20) return '💡';
    return '❌';
}

function getCalaverasPorProb(prob) {
    if (prob >= 0.85) return '💀';
    if (prob >= 0.60) return '💀💀';
    if (prob >= 0.40) return '💀💀💀';
    if (prob >= 0.15) return '💀💀💀💀';
    return '💀💀💀💀💀';
}

function getRangoConquistadorTexto(puntos) {
    if (puntos < 60) return 'no_despertado';
    if (puntos <= 79) return 'despertado';
    if (puntos <= 94) return 'basico';
    if (puntos <= 100) return 'avanzado';
    return 'supremo';
}

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
        positivo: { 'No despertado': '¡Sentís una chispa interior!', 'Despertado': '¡Tu espíritu se enciende!', 'Básico': '¡Tu cuerpo se vuelve más duro!', 'Avanzado': '¡Tu voluntad es inquebrantable!', 'Avanzado Élite': '¡Tu voluntad es inquebrantable!', 'Supremo': '¡Nadie puede detenerte!' },
        negativo: { 'No despertado': 'Tu Haki se resiste...', 'Despertado': 'El entrenamiento fue duro...', 'Básico': 'Golpeaste mal y perdiste fuerza...', 'Avanzado': 'Tu Armadura flaqueó un instante...', 'Avanzado Élite': 'Tu Armadura flaqueó un instante...', 'Supremo': 'Hasta los más fuertes fallan...' },
        neutro: { 'No despertado': 'Nada cambió... pero no te rindas.', 'Despertado': 'Tu Haki está estable.', 'Básico': 'Hoy no hubo cambios, pero seguís firme.', 'Avanzado': 'Nada te mueve, ni siquiera la suerte.', 'Avanzado Élite': 'Nada te mueve, ni siquiera la suerte.', 'Supremo': 'Nada puede tocarte, ni el azar.' }
    };
    const tipo = delta > 0 ? 'positivo' : delta < 0 ? 'negativo' : 'neutro';
    return textos[tipo][rango] || 'Sin cambios.';
}

function getMensajeNuevoRango(rango, usuario) {
    const mensajes = {
        'Despertado': '💡 ¡Felicidades ' + usuario + '! Tu Haki de Armadura ha despertado.',
        'Básico': '💪 ¡Tu defensa se vuelve confiable, ' + usuario + '! Nivel Básico alcanzado.',
        'Avanzado': '🔥 ¡Impresionante, ' + usuario + '! Tu Armadura tiene gran poder. Rango Avanzado.',
        'Supremo': '👑 ¡Como un emperador del mar, ' + usuario + ' ha dominado el Haki de Armadura! Ahora es SUPREMO.'
    };
    return mensajes[rango] || '';
}

function calcularRecompensa(user) {
    const arm = user.armadura || 0;
    const obs = user.observacion || 0;
    const conq = user.conquistador || 0;
    const tieneFruta = user.fruta ? 1 : 0;
    return (arm * 500000) + (obs * 500000) + (conq * 1000000) + (tieneFruta * 10000000);
}

// ============================================
// PENALIZACIÓN
// ============================================
const PENALIZACION_BASES = {
    no_despertado: { conq: 1, berries: 5000000 },
    despertado:    { conq: 2, berries: 10000000 },
    basico:        { conq: 3, berries: 20000000 },
    avanzado:      { conq: 5, berries: 30000000 },
    supremo:       { conq: 8, berries: 50000000 }
};

async function verificarPenalizacionExplorar(username) {
    const user = await getUsuario(username);
    if (!user) return null;
    const hoy = getFechaHoy();
    if (!user.ultimo_dia_exploracion) {
        await updateUsuario(username, { ultimo_dia_exploracion: hoy, dias_sin_explorar: 0 });
        return null;
    }
    const ultimo = new Date(user.ultimo_dia_exploracion);
    const ahora = new Date(hoy);
    const diffMs = ahora - ultimo;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const expected = Math.max(diffDays - 1, 0);
    const capped = Math.min(expected, 4);
    if (capped <= (user.dias_sin_explorar || 0)) return null;
    const rangoConq = getRangoConquistadorTexto(user.conquistador || 0);
    const base = PENALIZACION_BASES[rangoConq];
    const mult = capped;
    const perdConq = base.conq * mult;
    const perdBerries = base.berries * mult;
    const nuevoConq = Math.max((user.conquistador || 0) - perdConq, 0);
    await updateUsuario(username, {
        dias_sin_explorar: capped,
        conquistador: nuevoConq,
        recompensa_delta: (user.recompensa_delta || 0) - perdBerries
    });
    return { dias: capped, perdConq, perdBerries };
}

// ============================================
// SUPREMOS
// ============================================
let supremosCache = { data: [], timestamp: 0 };
const SUPREMOS_CACHE_TTL = 30000;

async function getSupremosActuales() {
    const ahora = Date.now();
    if (ahora - supremosCache.timestamp < SUPREMOS_CACHE_TTL) return supremosCache.data;
    try {
        const { data: dedicadosData, error: err1 } = await supabase
            .from('usuarios').select('username').gt('op_usos_hoy', 0);
        if (err1) return [];
        const numDedicados = (dedicadosData || []).length;
        const plazasBase = numDedicados === 0 ? 0 : Math.floor(numDedicados / 21) + 1;
        const { data: maxData } = await supabase
            .from('usuarios').select('armadura').order('armadura', { ascending: false }).limit(1);
        const maxArmadura = (maxData && maxData[0]) ? maxData[0].armadura : 0;
        const plazasExtra = maxArmadura >= 100 ? Math.floor((maxArmadura - 100) / 100) * 3 : 0;
        const { data: dueñoData } = await supabase
            .from('usuarios').select('supremos_min_historico').eq('username', DUEÑO).maybeSingle();
        const minHistorico = (dueñoData && dueñoData.supremos_min_historico) || 0;
        if (plazasBase > minHistorico) {
            await supabase.from('usuarios').update({ supremos_min_historico: plazasBase }).eq('username', DUEÑO);
        }
        const plazasBaseEfectivas = Math.max(plazasBase, minHistorico);
        let totalPlazas = numDedicados === 0
            ? Math.max(plazasExtra, minHistorico)
            : Math.max(plazasBaseEfectivas, plazasExtra + 1);
        if (totalPlazas === 0) { supremosCache = { data: [], timestamp: ahora }; return []; }
        const { data: topData } = await supabase
            .from('usuarios').select('username, armadura').gte('armadura', 100)
            .order('armadura', { ascending: false }).limit(totalPlazas);
        const result = (topData || []).map(u => u.username.toLowerCase());
        supremosCache = { data: result, timestamp: ahora };
        return result;
    } catch (err) { return []; }
}

async function esSupremo(username) {
    const supremos = await getSupremosActuales();
    return supremos.includes(username.toLowerCase());
}

// ============================================
// COMBATE (frutas)
// ============================================
function calcularPoderHakis(armadura, observacion, conquistador, esSupremoArmadura) {
    let aporteArmadura = 0;
    if (esSupremoArmadura || armadura >= 100) aporteArmadura = 250;
    else if (armadura >= 80) aporteArmadura = 200;
    else if (armadura >= 50) aporteArmadura = 125;
    else if (armadura >= 20) aporteArmadura = 50;

    let aporteObservacion = 0;
    if (observacion >= 100) aporteObservacion = 180;
    else if (observacion >= 80) aporteObservacion = 144;
    else if (observacion >= 50) aporteObservacion = 90;
    else if (observacion >= 20) aporteObservacion = 36;

    let aporteConquistador = 0;
    if (conquistador > 100) aporteConquistador = 400;
    else if (conquistador >= 95) aporteConquistador = 250;
    else if (conquistador >= 80) aporteConquistador = 150;
    else if (conquistador >= 60) aporteConquistador = 100;

    return aporteArmadura + aporteObservacion + aporteConquistador;
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
        victoria: pfU > pfE, diferencia,
        porcentaje: (diferencia / pfE) * 100
    };
}

function obtenerMensaje(victoria, porcentaje) {
    const cat = victoria ? 'victoria' : 'derrota';
    const absP = Math.abs(porcentaje);
    let rango = absP > 50 ? 'aplastante' : absP >= 20 ? 'clara' : absP >= 5 ? 'ajustada' : 'por_los_pelos';
    const mensajes = {
        victoria: {
            aplastante: ['¡VICTORIA ARROLLADORA! Tu poder es abrumador.', '¡HAS DEVASTADO A TU RIVAL!'],
            clara: ['¡VICTORIA CONTUNDENTE! Has dominado el combate.', '¡TRIUNFO SIN DISCUSIÓN!'],
            ajustada: ['¡VICTORIA SUDADA! Has ganado, pero no ha sido fácil.', '¡VICTORIA POR LOS JUSTOS!'],
            por_los_pelos: ['¡VICTORIA AGÓNICA!', '¡VICTORIA MILAGROSA!']
        },
        derrota: {
            aplastante: ['DERROTA ANIQUILADORA.', 'HAS SIDO BARRIDO.'],
            clara: ['DERROTA CLARA.', 'DERROTA SIN PALIATIVOS.'],
            ajustada: ['DERROTA AJUSTADA.', 'DERROTA POR POCO.'],
            por_los_pelos: ['DERROTA POR LOS PELOS.', 'DERROTA INEXTREMIS.']
        }
    };
    const pool = mensajes[cat][rango] || mensajes[cat]['ajustada'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================
// EXPLORAR
// ============================================
function calcularProbabilidadVictoria(pcfUser, pcfNpc) {
    return 1 / (1 + Math.exp(5 * ((pcfNpc / pcfUser) - 1)));
}

function getEscalon(ratio) {
    if (ratio <= 0.5) return 'mucho_mas_fuerte';
    if (ratio <= 0.75) return 'mas_fuerte';
    if (ratio <= 1.25) return 'parejo';
    if (ratio <= 1.5) return 'mas_debil';
    return 'mucho_mas_debil';
}

function redondearBerries(valor) {
    return Math.round(valor / 10000) * 10000;
}

function calcularRecompensasExplorar(npc, prob, victoria) {
    const baseConq = npc.recompensa_conquistador || 0;
    const baseBerries = npc.recompensa_berries || 0;
    let mult;
    if (victoria) {
        mult = Math.max(1 + (0.50 - prob) * 2, 0.1);
    } else {
        mult = Math.max(1 + (prob - 0.50) * 2, 0.1);
    }
    return {
        conq: Math.max(Math.round(baseConq * mult), 1),
        berries: Math.max(redondearBerries(baseBerries * mult), 0)
    };
}

// Ahora los textos vienen de Supabase (textos_eventos, grupo='explorar')
async function getMensajeContextualExplorar(victoria, escalon, margenKey) {
    let situacion;
    if (victoria) {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey === 'alto') situacion = 'victoria_underdog_goleada';
        else if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') situacion = 'victoria_underdog_poco';
        else if (escalon === 'parejo') situacion = 'victoria_parejo';
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') situacion = 'victoria_favorito_poco';
        else situacion = 'victoria_favorito_goleada';
    } else {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') situacion = 'derrota_underdog_poco';
        else if (escalon === 'mas_debil' || escalon === 'mucho_mas_debil') situacion = 'derrota_underdog_aplastado';
        else if (escalon === 'parejo') situacion = 'derrota_parejo';
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') situacion = 'derrota_favorito_poco';
        else situacion = 'derrota_favorito_aplastado';
    }
    return await getTextoExplorar(situacion);
}

async function seleccionarNPCs(pcfUsuario) {
    const { data: npcs } = await supabase.from('npcs').select('*');
    if (!npcs || npcs.length === 0) return null;
    const elegidos = new Set();
    const resultado = {};
    const orden = ['facil', 'dificil', 'medio'];
    const rangos = { facil: [0.65, 0.97], medio: [0.21, 0.64], dificil: [0.03, 0.20] };
    for (let bi = 0; bi < orden.length; bi++) {
        const bucket = orden[bi];
        const minProb = rangos[bucket][0];
        const maxProb = rangos[bucket][1];
        let candidatos = npcs.filter(npc => {
            if (elegidos.has(npc.nombre)) return false;
            const pcfNpc = npc.pcf_final || npc.pcf_calculado || 0;
            if (pcfNpc <= 0) return false;
            const prob = calcularProbabilidadVictoria(pcfUsuario, pcfNpc);
            return prob >= minProb && prob <= maxProb;
        });
        if (candidatos.length === 0) {
            candidatos = npcs.filter(npc => {
                if (elegidos.has(npc.nombre)) return false;
                const pcfNpc = npc.pcf_final || npc.pcf_calculado || 0;
                if (pcfNpc <= 0) return false;
                const ratio = pcfNpc / pcfUsuario;
                return ratio >= 0.75 && ratio <= 1.25;
            });
        }
        if (candidatos.length === 0) continue;
        const elegido = candidatos[Math.floor(Math.random() * candidatos.length)];
        elegidos.add(elegido.nombre);
        const pcfNpc = elegido.pcf_final || elegido.pcf_calculado || 0;
        const prob = calcularProbabilidadVictoria(pcfUsuario, pcfNpc);
        const pcfUserFinal = aplicarVariacion(pcfUsuario);
        const pcfNpcFinal = aplicarVariacion(pcfNpc);
        const victoria = pcfUserFinal > pcfNpcFinal;
        const ganador = Math.max(pcfUserFinal, pcfNpcFinal);
        const perdedor = Math.min(pcfUserFinal, pcfNpcFinal);
        const margen = (ganador - perdedor) / perdedor;
        const ratio = pcfNpc / pcfUsuario;
        const escalon = getEscalon(ratio);
        const margenKey = margen < 0.10 ? 'bajo' : margen < 0.30 ? 'medio' : 'alto';
        const recompensas = calcularRecompensasExplorar(elegido, prob, true);
        const castigos = calcularRecompensasExplorar(elegido, prob, false);
        resultado[bucket] = {
            npc: elegido.nombre, nivel: elegido.nivel, pcf_npc: pcfNpc, pcf_usuario: pcfUsuario,
            prob: prob, victoria: victoria, escalon: escalon, margen_key: margenKey,
            recompensa_conq: recompensas.conq, recompensa_berries: recompensas.berries,
            castigo_conq: castigos.conq, castigo_berries: castigos.berries
        };
    }
    if (Object.keys(resultado).length < 2) return null;
    return resultado;
}

function getCooldownExplorarMs() {
    return MODO_COOLDOWN === 'prueba' ? COOLDOWN_EXPLORAR_PRUEBA : COOLDOWN_EXPLORAR_PRODUCCION;
}

async function puedeExplorar(user) {
    if (!user.ultima_exploracion) return { ok: true };
    const ultima = new Date(user.ultima_exploracion).getTime();
    const ahora = Date.now();
    const diff = ahora - ultima;
    const cooldown = getCooldownExplorarMs();
    if (diff >= cooldown) return { ok: true };
    return { ok: false, restante: cooldown - diff };
}

function formatTiempoRestante(ms) {
    const totalSeg = Math.floor(ms / 1000);
    const h = Math.floor(totalSeg / 3600);
    const m = Math.floor((totalSeg % 3600) / 60);
    const s = totalSeg % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}

// ============================================
// DUELOS — helpers
// ============================================
async function calcularPCFUsuario(user) {
    let poderFruta = 0;
    if (user.fruta) {
        const { data: frutaData } = await supabase.from('frutas').select('poder_fruta').eq('nombre', user.fruta).single();
        poderFruta = (frutaData && frutaData.poder_fruta) ? frutaData.poder_fruta : 0;
    }
    const esSupremoUser = await esSupremo(user.username);
    return Math.round(calcularPoderBase(poderFruta, user.armadura || 0, user.observacion || 0, user.conquistador || 0, esSupremoUser));
}

function resolverDuelo(probRetador, retador, retado) {
    const probRetado = 1 - probRetador;
    const probDebil = Math.min(probRetador, probRetado);
    const tieProb = Math.min(0.10, 0.10 * Math.sqrt(2 * probDebil));
    const probDebilFinal = Math.max(0, probDebil - tieProb);
    const r = Math.random();
    if (r < probDebilFinal) {
        return { ganador: probRetador < probRetado ? retador : retado, empate: false };
    } else if (r < probDebil) {
        return { ganador: null, empate: true };
    } else {
        return { ganador: probRetador > probRetado ? retador : retado, empate: false };
    }
}

function calcularMontoDuelo(deltaPerdedor, pcfPerdedor, pcfGanador) {
    const deltaPos = Math.max(0, deltaPerdedor);
    if (deltaPos <= 0) return 0;
    const base = 0.30 * deltaPos;
    const ratio = pcfPerdedor / pcfGanador;
    const mult = Math.max(0.1, Math.min(5, ratio * ratio));
    return Math.min(base * mult, deltaPos);
}

function getSituacionDuelo(ganador, empate, retador, retado, probRetador) {
    if (empate) return 'empate';
    const probRetado = 1 - probRetador;
    const ganadorEsFuerte = (ganador === retador && probRetador >= probRetado) || (ganador === retado && probRetado >= probRetador);
    if (!ganadorEsFuerte) return 'upset';
    const probGanador = ganador === retador ? probRetador : probRetado;
    return probGanador > 0.65 ? 'victoria_esperada' : 'victoria_ajustada';
}

function aplicarPlaceholders(texto, datos) {
    return texto
        .replace(/\{retador\}/g, datos.retador || '')
        .replace(/\{retado\}/g, datos.retado || '')
        .replace(/\{ganador\}/g, datos.ganador || '')
        .replace(/\{perdedor\}/g, datos.perdedor || '')
        .replace(/\{monto\}/g, datos.monto || '0');
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
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const retador = row.evento_duelo_retador;
            const retado = row.evento_duelo_retado;
            const canal = row.evento_duelo_canal;
            const pcfRetador = row.evento_duelo_pcf_retador;
            await limpiarEventoDuelo(retador);
            if (retado && retado !== retador) await limpiarEventoDuelo(retado);
            const retadorUser = await getUsuario(retador);
            const retadoUser = retado ? await getUsuario(retado) : null;
            await crearDuelo({
                retador: retador,
                retado: retado || '',
                estado: 'expirado',
                pcf_retador: pcfRetador || null,
                pcf_retado: null,
                prob_retador: null,
                ganador: null,
                monto: 0,
                delta_retador: retadorUser ? (retadorUser.recompensa_delta || 0) : 0,
                delta_retado: retadoUser ? (retadoUser.recompensa_delta || 0) : 0,
                canal: canal
            });
        }
    } catch (err) {
        console.error('❌ Error timeout duelos:', err);
    }
}

// ============================================
// TEXTO DE AYUDA
// ============================================
const AYUDA_MENU = '📖 AYUDA - op_d_bot — ¿Qué querés ver? 💬 !ayudachat → Comandos de chat 📩 !ayudasusurro → Comandos de susurro';
const AYUDA_CHAT = '💬 COMANDOS DE CHAT 🎮 !op → Entrena Haki 📊 !infoop → Tu info 🍎 !fruta → Busca fruta 😋 !comer / ❌ !rechazar ⚔️ !retar @usuario → Duelo ✅ !aceptarduelo / ❌ !rechazarduelo 🏆 !historial @usuario';
const AYUDA_SUSURRO = '📩 COMANDOS DE SUSURRO 🗺️ !explorar ➡️ !continuar / ⬅️ !retroceder ⚔️ !combatir / 🏃 !retirarse ⏳ !exploracionpendiente ⚔️ !duelopendiente 📊 !infoop 👤 !infoop @usuario 🔄 !actualizacion';

// ============================================
// CLIENTE
// ============================================
const client = new tmi.Client({
    options: { debug: true },
    identity: { username: config.botName, password: config.oauth },
    channels: [config.channelName, 'op_d_bot']
});

client.connect()
    .then(() => console.log('Bot conectado como ' + config.botName + ' en #' + config.channelName + ' y #op_d_bot'))
    .catch(err => console.error('Error al conectar:', err));

// ============================================
// SUSURROS IRC
// ============================================
client.on('whisper', async (from, userstate, message, self) => {
    if (self) return;
    const fromUser = from.startsWith('#') ? from.slice(1) : from;
    console.log('📩 [SUSURRO] de ' + fromUser + ': ' + message);
    try {
        const fakeEvent = {
            from_user_id: userstate['user-id'],
            from_user_login: fromUser,
            whisper: { text: message }
        };
        await handleWhisper(fakeEvent);
    } catch (err) {
        console.error('❌ Error whisper:', err);
    }
});

// ============================================
// ENVIAR SUSURRO
// ============================================
async function sendWhisper(toUserId, message) {
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
        if (response.status === 204) console.log('✅ Susurro enviado a ' + toUserId);
        else console.error('❌ Error susurro: ' + response.status, await response.text());
    } catch (err) { console.error('❌ Error red susurro:', err); }
}

// ============================================
// HANDLER DE SUSURROS
// ============================================
async function handleWhisper(event) {
    const fromUserId = event.from_user_id;
    const fromUserLogin = event.from_user_login;
    const messageText = event.whisper.text.trim();
    const args = messageText.split(' ');
    const command = args[0].toLowerCase();
    const username = fromUserLogin.toLowerCase();

    if (!fromUserId) return;

    if (command === '!testwhisper') {
        await sendWhisper(fromUserId, '¡Hola ' + fromUserLogin + '! Funciona. 🎉');
        return;
    }
    if (command === '!ayuda' || command === '!ayudaop') { await sendWhisper(fromUserId, AYUDA_MENU); return; }
    if (command === '!ayudachat') { await sendWhisper(fromUserId, AYUDA_CHAT); return; }
    if (command === '!ayudasusurro') { await sendWhisper(fromUserId, AYUDA_SUSURRO); return; }

    if (command === '!actualizacion') {
        if (!commitInfo) { await sendWhisper(fromUserId, '🔄 Cargando...'); return; }
        const fecha = new Date(commitInfo.fecha);
        const fechaStr = fecha.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        await sendWhisper(fromUserId, '🔄 ' + fechaStr + ' | ' + commitInfo.mensaje);
        return;
    }

    if (command === '!infoop' && !args[1]) {
        const user = await getUsuario(username);
        if (!user) { await sendWhisper(fromUserId, 'Error al obtener datos.'); return; }
        const esSupremoUser = await esSupremo(username);
        let frutaTexto = '🍎 Ninguna';
        if (user.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = '🍎 ' + user.fruta + ' ' + ((frutaData && frutaData.emoji) || '');
        }
        const rangoArm = getRangoArmadura(user.armadura || 0, esSupremoUser);
        const rangoObs = getRangoArmadura(user.observacion || 0);
        const conqPts = user.conquistador || 0;
        let rangoConq;
        if (conqPts < 60) rangoConq = 'No despertado';
        else if (conqPts <= 79) rangoConq = 'Despertado';
        else if (conqPts <= 94) rangoConq = 'Básico';
        else if (conqPts <= 100) rangoConq = 'Avanzado';
        else rangoConq = 'Supremo';
        let estadoExplorar = 'disponible';
        if (user.evento_explorar_estado === 'pendiente') estadoExplorar = 'pendiente';
        else {
            const cd = await puedeExplorar(user);
            if (!cd.ok) estadoExplorar = 'usada. Próxima en ' + formatTiempoRestante(cd.restante);
        }
        const recompensaBase = calcularRecompensa(user);
        const recompensaReal = recompensaBase + Math.max(0, user.recompensa_delta || 0);
        const mensaje = '📊 Tus stats: ' + frutaTexto + ' | 🛡️ ' + rangoArm.nombre + ' (' + (user.armadura || 0) + ') ' + rangoArm.emoji + ' | 👁️ ' + rangoObs.nombre + ' (' + (user.observacion || 0) + ') | ⚜️ ' + rangoConq + ' (' + conqPts + ') | 🏴‍☠️💰 $' + recompensaReal.toLocaleString('es-AR') + ' | 🗺️ ' + estadoExplorar;
        await sendWhisper(fromUserId, mensaje);
        return;
    }

    if (command === '!infoop' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target);
        if (!targetUser) { await sendWhisper(fromUserId, 'No encontré a @' + target); return; }
        const esSupremoUser = await esSupremo(target);
        let frutaTexto = '🍎 Ninguna';
        if (targetUser.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', targetUser.fruta).single();
            frutaTexto = '🍎 ' + targetUser.fruta + ' ' + ((frutaData && frutaData.emoji) || '');
        }
        const emojiArm = getEmojiRango(targetUser.armadura || 0, 'armadura', esSupremoUser);
        const emojiObs = getEmojiRango(targetUser.observacion || 0, 'observacion');
        const emojiConq = getEmojiRango(targetUser.conquistador || 0, 'conquistador');
        await sendWhisper(fromUserId, '@' + target + ' | ' + frutaTexto + ' | 🛡️:' + emojiArm + ' | 👁️:' + emojiObs + ' | ⚜️:' + emojiConq + ' | 🏴‍☠️💰 $' + (targetUser.recompensa_publica || 0).toLocaleString('es-AR'));
        return;
    }

    if (command === '!frutapendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente') {
            await sendWhisper(fromUserId, 'No tenés evento de fruta pendiente.'); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            await sendWhisper(fromUserId, 'La fruta ya fue consumida.'); return;
        }
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) { await sendWhisper(fromUserId, 'Error.'); return; }
        if (user.evento_fruta_fase === 'avistamiento') {
            await sendWhisper(fromUserId, fruta.fase1 + ' — ✅ !si o ❌ !no');
        } else {
            const calaveras = getCalaverasPorProb(0.5);
            await sendWhisper(fromUserId, fruta.fase2 + ' ' + calaveras + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' — ⚔️ !pelear o 🏃 !huir');
        }
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
        if (user.evento_explorar_estado === 'pendiente') {
            if (user.evento_explorar_fase === 'menu') {
                const opciones = user.evento_explorar_opciones || {};
                const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
                let msg = '⏳ Ya tenés exploración en curso:';
                if (f) msg += ' 🟢 !facil ' + getCalaverasPorProb(f.prob);
                if (m) msg += ' 🟡 !medio ' + getCalaverasPorProb(m.prob);
                if (d) msg += ' 🔴 !dificil ' + getCalaverasPorProb(d.prob);
                await sendWhisper(fromUserId, msg); return;
            }
            const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
            if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
            const opciones = user.evento_explorar_opciones || {};
            const op = opciones[user.evento_explorar_dificultad];
            if (user.evento_explorar_fase === 'avistamiento') {
                await sendWhisper(fromUserId, '📍 Pendiente. ' + npc.fase1 + ' — ➡️ !continuar o ⬅️ !retroceder');
            } else {
                await sendWhisper(fromUserId, '📍 Pendiente. ' + npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' — ⚔️ !combatir o 🏃 !retirarse');
            }
            return;
        }
        const cd = await puedeExplorar(user);
        if (!cd.ok) { await sendWhisper(fromUserId, '⏳ Próxima en ' + formatTiempoRestante(cd.restante)); return; }
        let poderFrutaUsuario = 0;
        if (user.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('poder_fruta').eq('nombre', user.fruta).single();
            poderFrutaUsuario = (frutaData && frutaData.poder_fruta) ? frutaData.poder_fruta : 0;
        }
        const esSupremoUser = await esSupremo(username);
        const pcfUsuario = Math.round(calcularPoderBase(poderFrutaUsuario, user.armadura || 0, user.observacion || 0, user.conquistador || 0, esSupremoUser));
        const opciones = await seleccionarNPCs(pcfUsuario);
        if (!opciones) {
            await sendWhisper(fromUserId, '🗺️ No encontrás rivales. Volvé más tarde.');
            return;
        }
        await updateUsuario(username, {
            evento_explorar_estado: 'pendiente', evento_explorar_fase: 'menu',
            evento_explorar_dificultad: null, evento_explorar_npc: null, evento_explorar_nivel: null,
            evento_explorar_pcf_usuario: pcfUsuario, evento_explorar_pcf_npc: null,
            evento_explorar_comandos: null, evento_explorar_opciones: opciones,
            ultima_exploracion: new Date().toISOString(),
            ultimo_dia_exploracion: getFechaHoy(), dias_sin_explorar: 0
        });
        const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
        const total = [f, m, d].filter(Boolean).length;
        const plural = total === 3 ? 'tres caminos' : total === 2 ? 'dos caminos' : 'un camino';
        let msg = '🗺️ ¡Zarpás! Se divisan ' + plural + ':';
        if (f) msg += ' 🟢 !facil ' + getCalaverasPorProb(f.prob) + ' → +' + f.recompensa_conq + ' Conq / +$' + f.recompensa_berries.toLocaleString('es-AR');
        if (m) msg += ' 🟡 !medio ' + getCalaverasPorProb(m.prob) + ' → +' + m.recompensa_conq + ' Conq / +$' + m.recompensa_berries.toLocaleString('es-AR');
        if (d) msg += ' 🔴 !dificil ' + getCalaverasPorProb(d.prob) + ' → +' + d.recompensa_conq + ' Conq / +$' + d.recompensa_berries.toLocaleString('es-AR');
        await sendWhisper(fromUserId, msg);
        return;
    }

    if (command === '!facil' || command === '!medio' || command === '!dificil') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'menu') {
            await sendWhisper(fromUserId, 'No tenés exploración en esa fase.'); return;
        }
        const dificultad = command.substring(1);
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[dificultad];
        if (!op) { await sendWhisper(fromUserId, 'No hay opción ' + dificultad + '.'); return; }
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', op.npc).single();
        if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
        await updateUsuario(username, {
            evento_explorar_fase: 'avistamiento',
            evento_explorar_dificultad: dificultad,
            evento_explorar_npc: op.npc,
            evento_explorar_nivel: op.nivel,
            evento_explorar_pcf_npc: op.pcf_npc,
            evento_explorar_comandos: 'continuar_retroceder'
        });
        const castigoRetro = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
        await sendWhisper(fromUserId, npc.fase1 + ' — Retroceder: -' + castigoRetro + ' Conq. Continuar y perder: -' + op.castigo_conq + ' Conq / -$' + op.castigo_berries.toLocaleString('es-AR') + '. ➡️ !continuar o ⬅️ !retroceder');
        return;
    }

    if (command === '!continuar') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, 'No estás en avistamiento.'); return;
        }
        await updateUsuario(username, { evento_explorar_fase: 'encuentro', evento_explorar_comandos: 'combatir_retirarse' });
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        const castigoRet = Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
        await sendWhisper(fromUserId, npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' — Ganar: +' + op.recompensa_conq + ' Conq / +$' + op.recompensa_berries.toLocaleString('es-AR') + '. Perder: -' + op.castigo_conq + ' Conq / -$' + op.castigo_berries.toLocaleString('es-AR') + '. Retirarse: -' + castigoRet + ' Conq. ⚔️ !combatir o 🏃 !retirarse');
        return;
    }

    if (command === '!retroceder') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, 'No estás en avistamiento.'); return;
        }
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        const castigo = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigo, 0),
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        });
        const msgCtx = await getTextoExplorar('retroceder');
        await sendWhisper(fromUserId, msgCtx + ' -' + castigo + ' Conq.');
        return;
    }

    if (command === '!combatir') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, 'No estás en encuentro.'); return;
        }
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        if (!op) { await sendWhisper(fromUserId, 'Error.'); return; }
        const victoria = op.victoria;
        const msgCtx = await getMensajeContextualExplorar(victoria, op.escalon, op.margen_key);
        if (victoria) {
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + op.recompensa_conq,
                recompensa_delta: (user.recompensa_delta || 0) + op.recompensa_berries,
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, msgCtx + ' 🏆 ¡Victoria! +' + op.recompensa_conq + ' Conq. +$' + op.recompensa_berries.toLocaleString('es-AR'));
        } else {
            await updateUsuario(username, {
                conquistador: Math.max((user.conquistador || 0) - op.castigo_conq, 0),
                recompensa_delta: (user.recompensa_delta || 0) - op.castigo_berries,
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, msgCtx + ' 💀 Derrota. -' + op.castigo_conq + ' Conq. -$' + op.castigo_berries.toLocaleString('es-AR'));
        }
        return;
    }

    if (command === '!retirarse') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, 'No estás en encuentro.'); return;
        }
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        const castigo = Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigo, 0),
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        });
        const msgCtx = await getTextoExplorar('retirarse');
        await sendWhisper(fromUserId, msgCtx + ' -' + castigo + ' Conq.');
        return;
    }

    if (command === '!exploracionpendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente') {
            await sendWhisper(fromUserId, 'No tenés exploración pendiente.'); return;
        }
        if (user.evento_explorar_fase === 'menu') {
            const opciones = user.evento_explorar_opciones || {};
            const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
            let msg = '📍 Pendiente:';
            if (f) msg += ' 🟢 !facil';
            if (m) msg += ' 🟡 !medio';
            if (d) msg += ' 🔴 !dificil';
            await sendWhisper(fromUserId, msg); return;
        }
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
        if (user.evento_explorar_fase === 'avistamiento') {
            await sendWhisper(fromUserId, '📍 ' + npc.fase1 + ' — ➡️ !continuar o ⬅️ !retroceder');
        } else {
            const opciones = user.evento_explorar_opciones || {};
            const op = opciones[user.evento_explorar_dificultad];
            await sendWhisper(fromUserId, '📍 ' + npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' — ⚔️ !combatir o 🏃 !retirarse');
        }
        return;
    }

    // ============================================
    // DUELOS — comandos por susurro
    // ============================================
    if (command === '!aceptarduelo') {
        await procesarAceptarDuelo(username, fromUserId, true, null);
        return;
    }

    if (command === '!rechazarduelo') {
        await procesarRechazarDuelo(username, fromUserId, true, null);
        return;
    }

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
        const esSupremoOtro = await esSupremo(otro);
        const rangoArm = getRangoArmadura(otroUser.armadura || 0, esSupremoOtro);
        const rangoObs = getRangoArmadura(otroUser.observacion || 0);
        const conqPts = otroUser.conquistador || 0;
        let rangoConq;
        if (conqPts < 60) rangoConq = 'No despertado';
        else if (conqPts <= 79) rangoConq = 'Despertado';
        else if (conqPts <= 94) rangoConq = 'Básico';
        else if (conqPts <= 100) rangoConq = 'Avanzado';
        else rangoConq = 'Supremo';
        const fruta = otroUser.fruta || 'Sin fruta';
        const seg = Math.max(0, Math.floor((new Date(user.evento_duelo_expira).getTime() - Date.now()) / 1000));
        const yoReto = retador === username;
        await sendWhisper(fromUserId, '⚔️ Duelo pendiente (' + (yoReto ? 'retaste' : 'te retaron') + ')\nRetador: ' + retador + '\nRetado: ' + retado + '\nRival: ' + otro + ' | 🛡️ ' + rangoArm.nombre + ' | 👁️ ' + rangoObs.nombre + ' | ⚜️ ' + rangoConq + ' | 🍎 ' + fruta + ' | 💰 $' + (otroUser.recompensa_publica || 0).toLocaleString('es-AR') + '\nRestante: ' + seg + 's');
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
        const netoTxt = h.neto > 0 ? 'le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'le perdiste $' + formatBerries(Math.abs(h.neto)) : 'están a mano';
        await sendWhisper(fromUserId, '📊 vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }
}

// ============================================
// ACEPTAR / RECHAZAR
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
    const expira = new Date(user.evento_duelo_expira);
    if (expira < new Date()) {
        if (esSusurro) await sendWhisper(fromUserId, 'El duelo ya expiró.');
        else client.say(chatChannel, '@' + username + ' El duelo ya expiró.');
        return;
    }
    const retador = user.evento_duelo_retador;
    const retado = user.evento_duelo_retado;
    const pcfRetador = user.evento_duelo_pcf_retador;
    const canal = user.evento_duelo_canal;
    const retadorUser = await getUsuario(retador);
    const retadoUser = await getUsuario(retado);
    if (!retadorUser || !retadoUser) {
        await limpiarEventoDuelo(retador); await limpiarEventoDuelo(retado);
        if (esSusurro) await sendWhisper(fromUserId, 'Error.');
        return;
    }
    const pcfRetado = await calcularPCFUsuario(retadoUser);
    const probRetador = 1 / (1 + Math.exp(3 * ((pcfRetado / pcfRetador) - 1)));
    const res = resolverDuelo(probRetador, retador, retado);
    const ganador = res.ganador;
    const empate = res.empate;
    let monto = 0;
    if (!empate) {
        const perdedorUser = ganador === retador ? retadoUser : retadorUser;
        const pcfPerdedor = ganador === retador ? pcfRetado : pcfRetador;
        const pcfGanador = ganador === retador ? pcfRetador : pcfRetado;
        monto = Math.round(calcularMontoDuelo(perdedorUser.recompensa_delta || 0, pcfPerdedor, pcfGanador));
        if (ganador === retador) {
            await updateUsuario(retador, { recompensa_delta: (retadorUser.recompensa_delta || 0) + monto });
            await updateUsuario(retado, { recompensa_delta: (retadoUser.recompensa_delta || 0) - monto });
        } else {
            await updateUsuario(retado, { recompensa_delta: (retadoUser.recompensa_delta || 0) + monto });
            await updateUsuario(retador, { recompensa_delta: (retadorUser.recompensa_delta || 0) - monto });
        }
    }
    const situacion = getSituacionDuelo(ganador, empate, retador, retado, probRetador);
    const estadoDuelo = empate ? 'empate' : 'finalizado';
    await crearDuelo({
        retador: retador, retado: retado, estado: estadoDuelo,
        pcf_retador: pcfRetador, pcf_retado: pcfRetado,
        prob_retador: parseFloat(probRetador.toFixed(4)),
        ganador: ganador, monto: monto,
        delta_retador: Math.round(retadorUser.recompensa_delta || 0),
        delta_retado: Math.round(retadoUser.recompensa_delta || 0),
        canal: canal
    });
    await limpiarEventoDuelo(retador);
    await limpiarEventoDuelo(retado);
    const ahoraISO = new Date().toISOString();
    await updateUsuario(retador, { ultimo_duelo_timestamp: ahoraISO });
    await updateUsuario(retado, { ultimo_duelo_timestamp: ahoraISO });
    const textoBase = await getTextoDuelo(situacion);
    const perdedor = empate ? '' : (ganador === retador ? retado : retador);
    const texto = aplicarPlaceholders(textoBase, {
        retador: retador, retado: retado, ganador: ganador || '', perdedor: perdedor,
        monto: monto > 0 ? formatBerries(monto) : '0'
    });
    const publicar = canal || chatChannel;
    if (publicar) client.say(publicar, texto);
    if (esSusurro) await sendWhisper(fromUserId, texto);
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
    const canal = user.evento_duelo_canal;
    const retadorUser = await getUsuario(retador);
    const retadoUser = await getUsuario(retado);
    await crearDuelo({
        retador: retador, retado: retado, estado: 'rechazado',
        pcf_retador: pcfRetador, pcf_retado: retadoUser ? await calcularPCFUsuario(retadoUser) : null,
        prob_retador: null, ganador: null, monto: 0,
        delta_retador: retadorUser ? Math.round(retadorUser.recompensa_delta || 0) : 0,
        delta_retado: retadoUser ? Math.round(retadoUser.recompensa_delta || 0) : 0,
        canal: canal
    });
    await limpiarEventoDuelo(retador);
    await limpiarEventoDuelo(retado);
    const ahoraISO = new Date().toISOString();
    await updateUsuario(retador, { ultimo_duelo_timestamp: ahoraISO });
    await updateUsuario(retado, { ultimo_duelo_timestamp: ahoraISO });
    if (esSusurro) await sendWhisper(fromUserId, 'Rechazaste el duelo.');
    else client.say(chatChannel, '@' + username + ' Rechazaste el duelo.');
}

// ============================================
// COMANDOS DE CHAT
// ============================================
client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    if (channel.startsWith('##')) return;
    if (tags['message-type'] === 'whisper') return;

    const args = message.trim().split(' ');
    const command = args[0].toLowerCase();
    const username = tags.username.toLowerCase();

    console.log('💬 [' + channel + '] ' + username + ': ' + message);

    if (command === '!ayudaop') {
        client.say(channel, '@' + tags.username + ' 📩 Mandame !ayudaop por susurro.');
        return;
    }

    try {
        const penal = await verificarPenalizacionExplorar(username);
        if (penal) {
            client.say(channel, '@' + tags.username + ' 💤 No exploraste por ' + penal.dias + ' día(s). Perdiste ' + penal.perdConq + ' Conq y $' + penal.perdBerries.toLocaleString('es-AR'));
        }
    } catch (err) { console.error('Error penal:', err); }

    const comandosBloqueados = ['!op', '!fruta', '!comer'];
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

    // ============================================
    // !retar
    // ============================================
    if (command === '!retar') {
        if (args.length < 2) { client.say(channel, '@' + tags.username + ' Uso: !retar @usuario'); return; }
        const target = args[1].replace('@', '').toLowerCase();
        if (target === username) { client.say(channel, '@' + tags.username + ' No podés retarte a vos mismo.'); return; }
        const targetUser = await getUsuario(target);
        if (!targetUser) { client.say(channel, '@' + tags.username + ' @' + target + ' no está registrado.'); return; }
        const user = await getUsuario(username);
        if (!user) return;
        if (user.evento_duelo_estado === 'pendiente') {
            const otro = user.evento_duelo_retador === username ? user.evento_duelo_retado : user.evento_duelo_retador;
            client.say(channel, '@' + tags.username + ' Ya tenés un duelo pendiente con @' + otro + '.'); return;
        }
        if (user.evento_explorar_estado === 'pendiente' || user.evento_fruta_estado === 'pendiente') {
            client.say(channel, '@' + tags.username + ' Tenés un evento pendiente. Resolvelo antes.'); return;
        }
        if (!(await completoExplorarHoy(username))) {
            client.say(channel, '@' + tags.username + ' Necesitás completar tu !explorar del día.'); return;
        }
        if ((user.recompensa_delta || 0) < DUELO_DELTA_MINIMO) {
            client.say(channel, '@' + tags.username + ' Necesitás $100M+ de recompensa para retar.'); return;
        }
        if (user.ultimo_duelo_timestamp) {
            const ultimo = new Date(user.ultimo_duelo_timestamp).getTime();
            const diff = Date.now() - ultimo;
            if (diff < DUELO_COOLDOWN_MS) {
                const min = Math.ceil((DUELO_COOLDOWN_MS - diff) / 60000);
                client.say(channel, '@' + tags.username + ' Esperá ' + min + ' min.'); return;
            }
        }
        const duelosHoy = await contarDuelosHoy(username);
        if (duelosHoy >= DUELO_LIMITE_DIARIO) {
            client.say(channel, '@' + tags.username + ' Ya usaste tus 5 duelos de hoy.'); return;
        }
        const parejaHoy = await contarDuelosHoyEntre(username, target);
        if (parejaHoy >= DUELO_LIMITE_PAREJA) {
            client.say(channel, '@' + tags.username + ' Ya se enfrentaron 3 veces hoy.'); return;
        }
        if (await fueRechazadoHoy(username, target)) {
            client.say(channel, '@' + tags.username + ' @' + target + ' ya te rechazó hoy.'); return;
        }
        if (targetUser.evento_duelo_estado === 'pendiente') {
            client.say(channel, '@' + tags.username + ' @' + target + ' ya tiene duelo pendiente.'); return;
        }
        if (targetUser.evento_explorar_estado === 'pendiente' || targetUser.evento_fruta_estado === 'pendiente') {
            client.say(channel, '@' + tags.username + ' @' + target + ' está en medio de un evento.'); return;
        }
        if ((targetUser.recompensa_delta || 0) < DUELO_DELTA_MINIMO) {
            client.say(channel, '@' + tags.username + ' @' + target + ' no tiene $100M+ para duelar.'); return;
        }
        if (!(await completoExplorarHoy(target))) {
            client.say(channel, '@' + tags.username + ' @' + target + ' no completó su !explorar del día.'); return;
        }
        const pcfRetador = await calcularPCFUsuario(user);
        const expiraISO = new Date(Date.now() + DUELO_TIMEOUT_MS).toISOString();
        const evento = {
            evento_duelo_estado: 'pendiente',
            evento_duelo_retador: username,
            evento_duelo_retado: target,
            evento_duelo_pcf_retador: pcfRetador,
            evento_duelo_expira: expiraISO,
            evento_duelo_canal: channel
        };
        await updateUsuario(username, evento);
        await updateUsuario(target, evento);
        client.say(channel, '⚔️ @' + target + ', @' + tags.username + ' te ha retado. Tenés 2 minutos para !aceptarduelo o !rechazarduelo.');
        return;
    }

    if (command === '!aceptarduelo') {
        await procesarAceptarDuelo(username, null, false, channel);
        return;
    }

    if (command === '!rechazarduelo') {
        await procesarRechazarDuelo(username, null, false, channel);
        return;
    }

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
        const netoTxt = h.neto > 0 ? 'le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'le perdiste $' + formatBerries(Math.abs(h.neto)) : 'están a mano';
        client.say(channel, '📊 @' + username + ' vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }

    // ============================================
    // !infoop
    // ============================================
    if (command === '!infoop') {
        if (args[1]) { client.say(channel, '@' + tags.username + ' Por susurro, máquina 📩'); return; }
        const user = await getUsuario(username);
        if (!user) { client.say(channel, '@' + tags.username + ' Error.'); return; }
        const esSupremoUser = await esSupremo(username);
        const recompensaBase = calcularRecompensa(user);
        const recompensaReal = recompensaBase + Math.max(0, user.recompensa_delta || 0);
        await updateUsuario(username, { recompensa_publica: recompensaReal });
        let frutaTexto = '🍎 Ninguna';
        if (user.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = '🍎 ' + user.fruta + ' ' + ((frutaData && frutaData.emoji) || '');
        }
        const emojiArm = getEmojiRango(user.armadura || 0, 'armadura', esSupremoUser);
        const emojiObs = getEmojiRango(user.observacion || 0, 'observacion');
        const emojiConq = getEmojiRango(user.conquistador || 0, 'conquistador');
        client.say(channel, '@' + username + ' | ' + frutaTexto + ' | 🛡️:' + emojiArm + ' | 👁️:' + emojiObs + ' | ⚜️:' + emojiConq + ' | 🏴‍☠️💰 $' + recompensaReal.toLocaleString('es-AR'));
        return;
    }

    // ============================================
    // !op
    // ============================================
    if (command === '!op') {
        const user = await getUsuario(username);
        if (!user) return;
        const ahora = Date.now();
        const ultimoTs = user.ultimo_op_timestamp ? new Date(user.ultimo_op_timestamp).getTime() : 0;
        const tiempoRestante = (10 * 60 * 1000) - (ahora - ultimoTs);
        if (tiempoRestante > 0) {
            const min = Math.floor(tiempoRestante / 60000);
            const seg = Math.floor((tiempoRestante % 60000) / 1000);
            client.say(channel, '⏳ Faltan ' + min + 'm ' + seg + 's para !op.');
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
                if (delta !== 0) client.say(channel, '💤 Descuidaste. -' + Math.abs(delta) + ' Armadura.');
                await updateUsuario(username, { armadura: arm, op_usos_hoy: 0, ultimo_op_fecha: hoy, racha_ops: 0 });
            } else {
                await updateUsuario(username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
            }
        }
        const userAct = await getUsuario(username);
        if ((userAct.op_usos_hoy || 0) >= 3) {
            client.say(channel, 'Límite diario alcanzado.'); return;
        }
        const armActual = userAct.armadura || 0;
        const eraSupremo = await esSupremo(username);
        const rangoActual = getRangoArmadura(armActual, eraSupremo);
        const intervalo = getIntervaloTirada(rangoActual.nombre);
        const delta = tiradaAleatoria(intervalo.min, intervalo.max);
        const nuevaArm = Math.max(armActual + delta, 0);
        const nuevosUsos = (userAct.op_usos_hoy || 0) + 1;
        const updateData = {
            armadura: nuevaArm, op_usos_hoy: nuevosUsos,
            ultimo_op_fecha: hoy, ultimo_op_timestamp: new Date().toISOString()
        };
        const mensajesExtra = [];
        if (nuevosUsos === 3) {
            const bonusDiario = getBonusDiario(rangoActual.nombre);
            mensajesExtra.push('🔥 Diario: +' + bonusDiario);
            const ultimoDiaRacha = userAct.ultimo_dia_racha || null;
            let rachaActual = userAct.racha_ops || 0;
            rachaActual = (ultimoDiaRacha === getFechaAyer()) ? rachaActual + 1 : 1;
            const bonusRacha = getBonusRacha(rachaActual);
            mensajesExtra.push('🔥 Racha ' + rachaActual + 'd: +' + bonusRacha);
            updateData.armadura = nuevaArm + bonusDiario + bonusRacha;
            updateData.racha_ops = rachaActual;
            updateData.ultimo_dia_racha = hoy;
        }
        await updateUsuario(username, updateData);
        const ahoraSupremo = await esSupremo(username);
        const rangoFinal = getRangoArmadura(updateData.armadura, ahoraSupremo);
        const texto = getTextoResultado(rangoFinal.nombre, delta);
        let respuesta = '@' + tags.username + ' ' + texto + ' ' + (delta > 0 ? '+' : '') + delta + ' Armadura ' + rangoFinal.emoji;
        const rangoAnterior = eraSupremo ? 'Supremo' : getRangoArmadura(armActual).nombre;
        if (rangoAnterior !== rangoFinal.nombre) {
            const msg = getMensajeNuevoRango(rangoFinal.nombre, tags.username);
            if (msg) respuesta += ' | ' + msg;
        }
        if (mensajesExtra.length > 0) respuesta += ' | ' + mensajesExtra.join(' | ');
        client.say(channel, respuesta);
        return;
    }

    // ============================================
    // !fruta
    // ============================================
    if (command === '!fruta') {
        try {
            const user = await getUsuario(username);
            if (!user) return;
            if (user.fruta) { client.say(channel, '@' + tags.username + ' Ya tenés fruta.'); return; }
            if (user.evento_fruta_estado === 'pendiente') {
                client.say(channel, '@' + tags.username + ' Tenés evento de fruta pendiente.'); return;
            }
            const ahora = Date.now();
            const ultimoUso = cooldowns['fruta_' + username] || 0;
            const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
            if (tiempoRestante > 0) {
                client.say(channel, '@' + tags.username + ' Esperá ' + Math.ceil(tiempoRestante / 1000) + 's.'); return;
            }
            cooldowns['fruta_' + username] = Date.now();
            if (Math.random() * 100 > PROB_FRUTA) {
                client.say(channel, '@' + tags.username + ' Sin suerte.'); return;
            }
            const { data: usuariosConFruta } = await supabase.from('usuarios').select('fruta').not('fruta', 'is', null);
            const frutasOcupadas = (usuariosConFruta || []).map(u => u.fruta).filter(Boolean);
            let query = supabase.from('frutas').select('*');
            if (frutasOcupadas.length > 0) query = query.not('nombre', 'in', "('" + frutasOcupadas.join("','") + "')");
            const { data: frutasDisponibles, error: errFrutas } = await query;
            if (errFrutas || !frutasDisponibles || !frutasDisponibles.length) {
                client.say(channel, '@' + tags.username + ' No hay frutas disponibles.'); return;
            }
            const totalProb = frutasDisponibles.reduce((s, f) => s + (Number(f.probabilidad) || 0), 0);
            let selectedFruit = null;
            if (totalProb <= 0) selectedFruit = frutasDisponibles[Math.floor(Math.random() * frutasDisponibles.length)];
            else {
                let rp = Math.random() * totalProb;
                for (let i = 0; i < frutasDisponibles.length; i++) {
                    rp -= (Number(frutasDisponibles[i].probabilidad) || 0);
                    if (rp <= 0) { selectedFruit = frutasDisponibles[i]; break; }
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
                client.say(channel, '@' + tags.username + ' ' + selectedFruit.fase1 + ' — ✅ !si o ❌ !no');
            } else {
                await updateUsuario(username, { fruta_pendiente: selectedFruit.nombre });
                client.say(channel, '@' + tags.username + ' ¡Encontraste la ' + selectedFruit.nombre + ' ' + (selectedFruit.emoji || '') + '! !comer o !rechazar');
            }
        } catch (err) {
            console.error('❌ !fruta:', err);
            client.say(channel, '@' + tags.username + ' Error.');
        }
        return;
    }

    if (command === '!frutapendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente') {
            client.say(channel, '@' + tags.username + ' No tenés evento de fruta pendiente.'); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, '@' + tags.username + ' La fruta ya fue consumida.'); return;
        }
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) { client.say(channel, '@' + tags.username + ' Error.'); return; }
        if (user.evento_fruta_fase === 'avistamiento') {
            client.say(channel, '@' + tags.username + ' ' + fruta.fase1 + ' — ✅ !si o ❌ !no');
        } else {
            client.say(channel, '@' + tags.username + ' ' + fruta.fase2 + ' ' + getCalaverasPorProb(0.5) + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' — ⚔️ !pelear o 🏃 !huir');
        }
        return;
    }

    if (command === '!si') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, '@' + tags.username + ' No corresponde.'); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, '@' + tags.username + ' La fruta ya fue consumida.'); return;
        }
        await updateUsuario(username, { evento_fruta_fase: 'encuentro', evento_fruta_comandos: 'pelear_huir' });
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        client.say(channel, '@' + tags.username + ' ' + fruta.fase2 + ' ' + getCalaverasPorProb(0.5) + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' — ⚔️ !pelear o 🏃 !huir');
        return;
    }

    if (command === '!no') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, '@' + tags.username + ' No corresponde.'); return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, '@' + tags.username + ' Te retirás.'); return;
    }

    if (command === '!pelear') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
            client.say(channel, '@' + tags.username + ' No corresponde.'); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, '@' + tags.username + ' La fruta ya fue consumida.'); return;
        }
        const { data: frutaData } = await supabase.from('frutas').select('poder_fruta, sombra, emoji').eq('nombre', user.evento_fruta_nombre).single();
        const poderFrutaUsuario = (frutaData && frutaData.poder_fruta) ? frutaData.poder_fruta : 0;
        const nombreSombra = (frutaData && frutaData.sombra) ? frutaData.sombra : null;
        const emojiFruta = (frutaData && frutaData.emoji) || '';
        const esSupremoUser = await esSupremo(username);
        const poderUsuario = calcularPoderBase(poderFrutaUsuario, user.armadura || 0, user.observacion || 0, user.conquistador || 0, esSupremoUser);
        let poderEnemigoBase = 80;
        if (nombreSombra) {
            const { data: npc } = await supabase.from('npcs').select('pcf_final, pcf_calculado').eq('nombre', nombreSombra).maybeSingle();
            poderEnemigoBase = (npc && (npc.pcf_final || npc.pcf_calculado)) || 80;
        } else poderEnemigoBase = 20 + (user.evento_fruta_nivel || 4) * 15;
        const resultado = calcularCombate(poderUsuario, poderEnemigoBase);
        const nivel = user.evento_fruta_nivel || 4;
        const baseConq = nivel * 5;
        const baseBerries = nivel * 1000000;
        const recConq = resultado.victoria ? baseConq : -Math.floor(baseConq / 2);
        const recBerries = resultado.victoria ? baseBerries : -Math.floor(baseBerries / 4);
        const mensaje = obtenerMensaje(resultado.victoria, resultado.porcentaje);
        if (resultado.victoria) {
            const { data: usuarioConFruta } = await supabase.from('usuarios').select('username').eq('fruta', user.evento_fruta_nombre).maybeSingle();
            if (usuarioConFruta) {
                await updateUsuario(username, {
                    conquistador: (user.conquistador || 0) + recConq,
                    recompensa_delta: (user.recompensa_delta || 0) + recBerries,
                    evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                    evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                    evento_fruta_comida_por_otro: false
                });
                client.say(channel, '@' + tags.username + ' ' + mensaje + ' Pero ya fue consumida.'); return;
            }
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConq,
                recompensa_delta: (user.recompensa_delta || 0) + recBerries,
                fruta: user.evento_fruta_nombre,
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, '@' + tags.username + ' ' + mensaje + ' 🍎 ¡Obtuviste la ' + user.evento_fruta_nombre + ' ' + emojiFruta + '!');
            const { data: afectados } = await supabase.from('usuarios').select('username')
                .eq('evento_fruta_nombre', user.evento_fruta_nombre)
                .eq('evento_fruta_estado', 'pendiente').neq('username', username);
            if (afectados && afectados.length > 0) {
                for (let i = 0; i < afectados.length; i++) await updateUsuario(afectados[i].username, { evento_fruta_comida_por_otro: true });
            }
        } else {
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + recConq,
                recompensa_delta: (user.recompensa_delta || 0) + recBerries,
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, '@' + tags.username + ' ' + mensaje);
        }
        return;
    }

    if (command === '!huir') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
            client.say(channel, '@' + tags.username + ' No corresponde.'); return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, '@' + tags.username + ' Huiste.'); return;
    }

    if (command === '!comer') {
        const user = await getUsuario(username);
        if (user && user.fruta_pendiente) {
            const { data: frutaData } = await supabase.from('frutas').select('descripcion, emoji').eq('nombre', user.fruta_pendiente).single();
            await updateUsuario(username, { fruta: user.fruta_pendiente, fruta_pendiente: null });
            client.say(channel, '@' + tags.username + ' Consumiste la ' + user.fruta_pendiente + ' ' + ((frutaData && frutaData.emoji) || '') + '.');
        } else {
            client.say(channel, '@' + tags.username + ' FELICIDADES TE COMISTE... ESTA 🫱');
        }
        return;
    }

    if (command === '!rechazar') {
        const user = await getUsuario(username);
        if (user && user.fruta_pendiente) {
            await updateUsuario(username, { fruta_pendiente: null });
            client.say(channel, '@' + tags.username + ' Rechazaste la ' + user.fruta_pendiente + '.');
        } else if (user && user.fruta) {
            client.say(channel, '@' + tags.username + ' Ya tenés fruta.');
        } else {
            client.say(channel, '@' + tags.username + ' Como te rechazaron toda tu vida, ¿no?');
        }
        return;
    }

    // ============================================
    // ADMIN
    // ============================================
    if (!esDueño(username)) return;
    const ADMIN_STATS = {
        sumar1: { campo: 'armadura', nombre: 'armadura', signo: 1 },
        sumar2: { campo: 'observacion', nombre: 'observación', signo: 1 },
        sumar3: { campo: 'conquistador', nombre: 'conquistador', signo: 1 },
        restar1: { campo: 'armadura', nombre: 'armadura', signo: -1 },
        restar2: { campo: 'observacion', nombre: 'observación', signo: -1 },
        restar3: { campo: 'conquistador', nombre: 'conquistador', signo: -1 }
    };
    const cmdName = command.substring(1);
    if (ADMIN_STATS[cmdName]) {
        const info = ADMIN_STATS[cmdName];
        if (args.length < 3) return client.say(channel, '@' + tags.username + ' Uso: ' + command + ' @usuario cantidad');
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, '@' + tags.username + ' Cantidad inválida.');
        const user = await getUsuario(target);
        if (!user) return;
        const actual = user[info.campo] || 0;
        const nuevo = info.signo > 0 ? actual + cantidad : Math.max(actual - cantidad, 0);
        await updateUsuario(target, { [info.campo]: nuevo });
        client.say(channel, '@' + tags.username + ' ' + (info.signo > 0 ? 'Sumado' : 'Restado') + ' ' + cantidad + ' ' + info.nombre + ' a @' + target + '. Ahora: ' + nuevo);
        return;
    }
    if (command === '!quitarfruta') {
        if (args.length < 2) return client.say(channel, '@' + tags.username + ' Uso: !quitarfruta @usuario');
        const target = args[1].replace('@', '').toLowerCase();
        await updateUsuario(target, { fruta: null, fruta_pendiente: null });
        client.say(channel, '@' + tags.username + ' Fruta quitada a @' + target + '.'); return;
    }
});

// ============================================
// INICIALIZACIÓN
// ============================================
cargarCommitInfo().then(() => console.log('📦 Commit info cargado.'));

setInterval(ejecutarTimeoutDuelos, 60 * 1000);

console.log('Bot escuchando...');