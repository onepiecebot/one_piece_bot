require('dotenv').config();
const tmi = require('tmi.js');
const config = require('./config.js');
const db = require('./database.js');
const {
    getUsuario, updateUsuario, supabase,
    getTextoDuelo, getTextoExplorar, getHistorialH2H,
    contarDuelosHoy, contarDuelosHoyEntre, fueRechazadoHoy,
    crearDuelo, limpiarEventoDuelo,
    completoExplorarHoy, getFechaHoy, getFechaOffset, getFechaNpc,
    usuarioExiste,
    getLurkStats, updateLurkStats,
    getHistorialLurk, agregarPuntosObservacion, recalcularObservacion,
    limpiarHistorialViejo, getCanal, getCanales, updateCanal,
    huboStreamEseDia, inicializarDiaLurk
} = db;

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

const DUELO_DELTA_MINIMO = 100000000;
const DUELO_COOLDOWN_MS = 10 * 60 * 1000;
const DUELO_LIMITE_DIARIO = 5;
const DUELO_LIMITE_PAREJA = 3;
const DUELO_TIMEOUT_MS = 2 * 60 * 1000;

const CANALES_CON_LURK = ['lenno_ap'];
const LURK_POSTA_MINUTOS = 20;
const LURK_POSTAS_MAX = 3;
const LURK_MICRO_COOLDOWN_MS = 2 * 60 * 1000;
const LURK_LIVE_MINIMO_2H = 120;

const NPC_VENTANA_MINUTOS = 10;
const MODO_TESTEO_LURK = true;

const esDueño = (username) => username.toLowerCase() === DUEÑO;

const cooldowns = {};
const cooldownsLurk = {};
const cooldownsCanaleson = {};
const cooldownsOnOff = {};
const notif5Plazas = { fecha: null, enviado: false };

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

function esModOCaster(tags) {
    if (tags.badges && tags.badges.broadcaster === '1') return true;
    if (tags.mod === true) return true;
    return false;
}

function normalizarComando(cmd) {
    return cmd.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
    if (puntos >= 80) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 50) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 20) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

function getRangoObservacion(puntos, esSupremo) {
    if (esSupremo) return { nombre: 'Supremo', emoji: '👑', idx: 4 };
    if (puntos >= 80) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 50) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 20) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

function getRangoConquistador(puntos, esSupremo) {
    if (esSupremo) return { nombre: 'Supremo', emoji: '👑', idx: 4 };
    if (puntos >= 95) return { nombre: 'Avanzado', emoji: '🔥', idx: 3 };
    if (puntos >= 80) return { nombre: 'Básico', emoji: '💪', idx: 2 };
    if (puntos >= 60) return { nombre: 'Despertado', emoji: '💡', idx: 1 };
    return { nombre: 'No despertado', emoji: '❌', idx: 0 };
}

function getPtsPostasPorRango(idxRango) {
    const tabla = {
        0: [2, 2, 4],
        1: [2, 2, 3],
        2: [1, 2, 3],
        3: [1, 1, 3],
        4: [1, 1, 2]
    };
    return tabla[idxRango] || tabla[0];
}

function calcularBonusRacha(racha) {
    if (racha <= 15) return (racha % 5 === 0) ? 5 : 1;
    return (racha % 5 === 0) ? 10 : 2;
}

function getCalaverasPorProb(prob) {
    if (prob >= 0.85) return '💀';
    if (prob >= 0.60) return '💀💀';
    if (prob >= 0.40) return '💀💀💀';
    if (prob >= 0.15) return '💀💀💀💀';
    return '💀💀💀💀💀';
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
function calcularRecompensa(user) {
    const arm = user.armadura || 0;
    const obs = user.observacion || 0;
    const conq = user.conquistador || 0;
    const tieneFruta = user.fruta ? 1 : 0;
    return (arm * 500000) + (obs * 500000) + (conq * 1000000) + (tieneFruta * 10000000);
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
    const diffDays = Math.floor((ahora - ultimo) / (1000 * 60 * 60 * 24));
    const expected = Math.max(diffDays - 1, 0);
    const capped = Math.min(expected, 4);
    if (capped <= (user.dias_sin_explorar || 0)) return null;
    const rangoConq = getRangoConquistadorTexto(user.conquistador || 0);
    const base = PENALIZACION_BASES[rangoConq];
    const perdConq = base.conq * capped;
    const perdBerries = base.berries * capped;
    await updateUsuario(username, {
        dias_sin_explorar: capped,
        conquistador: Math.max((user.conquistador || 0) - perdConq, 0),
        recompensa_delta: (user.recompensa_delta || 0) - perdBerries
    });
    return { dias: capped, perdConq, perdBerries };
}

// ============================================
// SUPREMOS DINÁMICOS
// ============================================
let supremosCacheArm = { data: [], timestamp: 0 };
let supremosCacheObs = { data: [], timestamp: 0 };
let supremosCacheConq = { data: [], timestamp: 0 };
const SUPREMOS_CACHE_TTL = 30000;

function calcularPlazasPorDedicados(dedicados) {
    if (dedicados <= 10) return 1;
    if (dedicados <= 20) return 2;
    if (dedicados <= 40) return 3;
    if (dedicados <= 70) return 4;
    return 5;
}

function calcularPlazasPorPuntos(topPuntos) {
    if (topPuntos < 100) return 0;
    return 6 + Math.floor((topPuntos - 100) / 50);
}

async function getDedicadosHoy() {
    const { data } = await supabase.from('usuarios').select('username').gt('op_usos_hoy', 0);
    return (data || []).length;
}

async function calcularSupremos(campo, cache) {
    const ahora = Date.now();
    if (ahora - cache.timestamp < SUPREMOS_CACHE_TTL) return cache.data;
    try {
        const dedicados = await getDedicadosHoy();
        const plazasDedicados = calcularPlazasPorDedicados(dedicados);
        const { data: maxData } = await supabase
            .from('usuarios').select(campo).order(campo, { ascending: false }).limit(1);
        const topPuntos = (maxData && maxData[0]) ? (maxData[0][campo] || 0) : 0;
        const plazasPuntos = calcularPlazasPorPuntos(topPuntos);
        const totalPlazas = Math.max(plazasDedicados, plazasPuntos);
        const hoy = getFechaHoy();
        if (plazasDedicados >= 5 && (notif5Plazas.fecha !== hoy || !notif5Plazas.enviado)) {
            notif5Plazas.fecha = hoy;
            notif5Plazas.enviado = true;
            const dueñoUser = await getUsuario(DUEÑO);
            if (dueñoUser && dueñoUser.twitch_user_id) {
                try {
                    await sendWhisper(dueñoUser.twitch_user_id, '🎉 Se alcanzó 5 plazas de Supremos.');
                } catch (e) {}
            }
        }
        const { data: topData } = await supabase
            .from('usuarios').select('username, ' + campo)
            .gt(campo, 0).order(campo, { ascending: false })
            .limit(Math.max(totalPlazas * 3, 30));
        if (!topData || topData.length === 0) {
            cache.data = [];
            cache.timestamp = ahora;
            return [];
        }
        const elegibles = topData.filter(u => (u[campo] || 0) >= 100);
        if (elegibles.length === 0) {
            cache.data = [];
            cache.timestamp = ahora;
            return [];
        }
        const corteIdx = Math.min(totalPlazas, elegibles.length) - 1;
        const valorCorte = elegibles[corteIdx][campo];
        const result = elegibles
            .filter(u => (u[campo] || 0) >= valorCorte)
            .map(u => u.username.toLowerCase());
        cache.data = result;
        cache.timestamp = ahora;
        return result;
    } catch (err) {
        console.error('❌ Error calcularSupremos ' + campo + ':', err);
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
    if (puntos >= 80) return 200;
    if (puntos >= 50) return 125;
    if (puntos >= 20) return 50;
    return 0;
}
function calcularAporteObservacion(puntos, esSupremo) {
    if (esSupremo) return 180;
    if (puntos >= 80) return 144;
    if (puntos >= 50) return 90;
    if (puntos >= 20) return 36;
    return 0;
}
function calcularAporteConquistador(puntos, esSupremo) {
    if (esSupremo) return 400;
    if (puntos >= 95) return 250;
    if (puntos >= 80) return 150;
    if (puntos >= 60) return 100;
    return 0;
}

async function calcularPCFUsuario(user) {
    let poderFruta = 0;
    if (user.fruta) {
        const { data: f } = await supabase.from('frutas').select('poder_fruta').eq('nombre', user.fruta).single();
        poderFruta = (f && f.poder_fruta) ? f.poder_fruta : 0;
    }
    const supArm = await esSupremoArmadura(user.username);
    const supObs = await esSupremoObservacion(user.username);
    const supConq = await esSupremoConquistador(user.username);
    const aporte = calcularAporteArmadura(user.armadura || 0, supArm)
        + calcularAporteObservacion(user.observacion || 0, supObs)
        + calcularAporteConquistador(user.conquistador || 0, supConq);
    return Math.round(poderFruta + aporte);
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
    return 1 / (1 + Math.exp(5 * ((pcfN / pcfU) - 1)));
}
function getEscalon(ratio) {
    if (ratio <= 0.5) return 'mucho_mas_fuerte';
    if (ratio <= 0.75) return 'mas_fuerte';
    if (ratio <= 1.25) return 'parejo';
    if (ratio <= 1.5) return 'mas_debil';
    return 'mucho_mas_debil';
}
function redondearBerries(v) { return Math.round(v / 10000) * 10000; }

function calcularRecompensasExplorar(npc, prob, victoria) {
    const baseConq = npc.recompensa_conquistador || 0;
    const baseBerries = npc.recompensa_berries || 0;
    const mult = victoria
        ? Math.max(1 + (0.50 - prob) * 2, 0.1)
        : Math.max(1 + (prob - 0.50) * 2, 0.1);
    return {
        conq: Math.max(Math.round(baseConq * mult), 1),
        berries: Math.max(redondearBerries(baseBerries * mult), 0)
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

async function seleccionarNPCs(pcfUsuario) {
    const { data: npcs } = await supabase.from('npcs').select('*');
    if (!npcs || npcs.length === 0) return null;
    const elegidos = new Set();
    const resultado = {};
    const orden = ['facil', 'dificil', 'medio'];
    const rangos = { facil: [0.65, 0.97], medio: [0.21, 0.64], dificil: [0.03, 0.20] };
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
            cand = npcs.filter(n => {
                if (elegidos.has(n.nombre)) return false;
                const p = n.pcf_final || n.pcf_calculado || 0;
                if (p <= 0) return false;
                const r = p / pcfUsuario;
                return r >= 0.75 && r <= 1.25;
            });
        }
        if (cand.length === 0) continue;
        const el = cand[Math.floor(Math.random() * cand.length)];
        elegidos.add(el.nombre);
        const pcfNpc = el.pcf_final || el.pcf_calculado || 0;
        const prob = calcularProbabilidadVictoria(pcfUsuario, pcfNpc);
        const pcfU = aplicarVariacion(pcfUsuario);
        const pcfN = aplicarVariacion(pcfNpc);
        const victoria = pcfU > pcfN;
        const gan = Math.max(pcfU, pcfN), per = Math.min(pcfU, pcfN);
        const margen = (gan - per) / per;
        const ratio = pcfNpc / pcfUsuario;
        const escalon = getEscalon(ratio);
        const margenKey = margen < 0.10 ? 'bajo' : margen < 0.30 ? 'medio' : 'alto';
        const rec = calcularRecompensasExplorar(el, prob, true);
        const cast = calcularRecompensasExplorar(el, prob, false);
        resultado[bucket] = {
            npc: el.nombre, nivel: el.nivel, pcf_npc: pcfNpc, pcf_usuario: pcfUsuario,
            prob, victoria, escalon, margen_key: margenKey,
            recompensa_conq: rec.conq, recompensa_berries: rec.berries,
            castigo_conq: cast.conq, castigo_berries: cast.berries
        };
    }
    if (Object.keys(resultado).length < 2) return null;
    return resultado;
}

async function puedeExplorar(user) {
    if (MODO_COOLDOWN === 'produccion') {
        const hoy = getFechaHoy();
        if (!user.ultimo_dia_exploracion || user.ultimo_dia_exploracion !== hoy) return { ok: true };
        const ahora = new Date();
        const offsetArg = -3 * 60;
        const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
        const argNow = new Date(utc + (offsetArg * 60000));
        const manana = new Date(argNow);
        manana.setDate(manana.getDate() + 1);
        manana.setHours(0, 0, 0, 0);
        return { ok: false, restante: manana.getTime() - argNow.getTime() };
    }
    if (!user.ultima_exploracion) return { ok: true };
    const diff = Date.now() - new Date(user.ultima_exploracion).getTime();
    if (diff >= COOLDOWN_EXPLORAR_PRUEBA) return { ok: true };
    return { ok: false, restante: COOLDOWN_EXPLORAR_PRUEBA - diff };
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
        for (const row of data) {
            const retador = row.evento_duelo_retador;
            const retado = row.evento_duelo_retado;
            const canal = row.evento_duelo_canal;
            const pcfRet = row.evento_duelo_pcf_retador;
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
            if (rU && rU.twitch_user_id) {
                try {
                    const t = await getTextoDuelo('expiracion');
                    await sendWhisper(rU.twitch_user_id, '⌛ ' + aplicarPlaceholders(t, { retador, retado: retado || '', monto: '0' }));
                } catch (e) { console.error('Error notif expiración:', e); }
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
    await inicializarDiaLurk(username);
    const lurk = await getLurkStats(username);
    if (!lurk) return;
    if (lurk.lurk_join_actual) {
        const desde = Date.now() - new Date(lurk.lurk_join_actual).getTime();
        if (desde < LURK_MICRO_COOLDOWN_MS) {
            console.log('👁️ JOIN (micro-cooldown): ' + username);
            return;
        }
        await lurkCerrarBloque(username);
    }
    await updateLurkStats(username, { lurk_join_actual: new Date().toISOString() });
    console.log('👁️ JOIN (bloque abierto): ' + username);
}

async function lurkPart(username) {
    const lurk = await getLurkStats(username);
    if (!lurk || !lurk.lurk_join_actual) return;
    await lurkCerrarBloque(username);
    console.log('👁️ PART (bloque cerrado): ' + username);
}

async function lurkCerrarBloque(username) {
    const lurk = await getLurkStats(username);
    if (!lurk || !lurk.lurk_join_actual) return;
    const user = await getUsuario(username);
    if (!user) return;
    const inicio = new Date(lurk.lurk_join_actual).getTime();
    const minutosBloque = Math.max(0, Math.floor((Date.now() - inicio) / 60000));
    const totalAntes = lurk.lurk_minutos_hoy || 0;
    const totalDespues = Math.min(60, totalAntes + minutosBloque);
    const minutosReales = totalDespues - totalAntes;
    let idxRango = lurk.lurk_rango_inicio;
    if (idxRango === null || idxRango === undefined) {
        const supObs = await esSupremoObservacion(username);
        idxRango = getRangoObservacion(user.observacion || 0, supObs).idx;
        await updateLurkStats(username, { lurk_rango_inicio: idxRango });
    }
    const ptsRango = getPtsPostasPorRango(idxRango);
    const postasPrev = lurk.lurk_postas_hoy || 0;
    const postasNuevas = Math.min(3, Math.floor(totalDespues / 20));
    let ptsNuevos = 0;
    for (let i = postasPrev; i < postasNuevas; i++) ptsNuevos += ptsRango[i] || 0;
    let rachaNueva = lurk.lurk_racha || 0;
    let ultimoDiaRacha = lurk.lurk_ultimo_dia_racha;
    if (postasNuevas >= 3 && postasPrev < 3) {
        const hoy = getFechaHoy();
        if (ultimoDiaRacha !== hoy) {
            const ayer = getFechaOffset(-1);
            rachaNueva = (ultimoDiaRacha === ayer) ? (rachaNueva + 1) : 1;
            ptsNuevos += calcularBonusRacha(rachaNueva);
            ultimoDiaRacha = hoy;
        }
        if (lurk.lurk_npc_pendiente > 0) {
            ptsNuevos += lurk.lurk_npc_pendiente;
            await updateLurkStats(username, { lurk_npc_pendiente: 0 });
        }
    }
    await updateLurkStats(username, {
        lurk_minutos_hoy: totalDespues,
        lurk_postas_hoy: postasNuevas,
        lurk_puntos_hoy: (lurk.lurk_puntos_hoy || 0) + ptsNuevos,
        lurk_racha: rachaNueva,
        lurk_ultimo_dia_racha: ultimoDiaRacha,
        lurk_join_actual: null,
        lurk_ultimo_chequeo: new Date().toISOString(),
        minutos_lurk_total: (lurk.minutos_lurk_total || 0) + minutosReales
    });
    if (ptsNuevos !== 0) await agregarPuntosObservacion(username, ptsNuevos, minutosReales);
    if (minutosReales > 0) {
        await updateUsuario(username, { minutos_lurk: (user.minutos_lurk || 0) + minutosReales });
    }
    console.log('📊 Lurk cerrado: ' + username + ' → ' + totalDespues + ' min, ' + postasNuevas + ' postas, +' + ptsNuevos + ' pts');
    const userFresh = await getUsuario(username);
    if (userFresh) {
        const supObs = await esSupremoObservacion(username);
        const rangoActual = getRangoObservacion(userFresh.observacion || 0, supObs);
        const rangoNotif = lurk.lurk_rango_notificado;
        if (rangoActual.idx > rangoNotif) {
            console.log('⬆️ Rango: ' + username + ' → Observación ' + rangoActual.nombre);
            if (userFresh.twitch_user_id && rangoActual.idx >= 1 && rangoActual.idx <= 5) {
                const msg = MENSAJES_RANGO_OBS[rangoActual.idx];
                if (msg) { try { await sendWhisper(userFresh.twitch_user_id, msg); } catch (e) { console.error('Error notif rango:', e); } }
            }
            await updateLurkStats(username, { lurk_rango_notificado: rangoActual.idx });
        }
    }
}

async function lurkProcesarPostas(username) {
    return await lurkCerrarBloque(username);
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

async function obtenerBroadcasterId(canal) {
    if (broadcasterIdsCache[canal]) return broadcasterIdsCache[canal];
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
        if (id) broadcasterIdsCache[canal] = id;
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
            const { data: abiertos } = await supabase.from('lurk_stats')
                .select('username').not('lurk_join_actual', 'is', null);
            if (abiertos && abiertos.length > 0) {
                for (const a of abiertos) {
                    await lurkCerrarBloque(a.username);
                }
                console.log('👁️ Scan ' + canal + ': canal offline, ' + abiertos.length + ' bloques cerrados');
            } else {
                console.log('👁️ Scan ' + canal + ': canal offline, sin bloques abiertos');
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

        // 3. Usuarios registrados
        const { data: usuariosDb } = await supabase.from('usuarios').select('username');
        const usuariosSet = new Set((usuariosDb || []).map(u => u.username.toLowerCase()));

        // 4. Registrados que están en el chat
        const enChat = new Set();
        for (const ch of chatters) {
            const u = ch.user_login.toLowerCase();
            if (usuariosSet.has(u)) enChat.add(u);
        }

        // 5. Reabrir bloques de los que están en el chat
        let reabiertos = 0;
        for (const username of enChat) {
            const lurk = await getLurkStats(username);
            if (!lurk) continue;
            if (lurk.lurk_join_actual) await lurkCerrarBloque(username);
            await inicializarDiaLurk(username);
            await updateLurkStats(username, { lurk_join_actual: new Date().toISOString() });
            reabiertos++;
        }

        // 6. Cerrar bloques de registrados que ya NO están en el chat
        const { data: conBloque } = await supabase.from('lurk_stats')
            .select('username').not('lurk_join_actual', 'is', null);
        let cerrados = 0;
        if (conBloque) {
            for (const row of conBloque) {
                if (!enChat.has(row.username) && usuariosSet.has(row.username)) {
                    await lurkCerrarBloque(row.username);
                    cerrados++;
                }
            }
        }

        console.log('👁️ Scan ' + canal + ': ' + chatters.length + ' chatters, ' +
            enChat.size + ' registrados, ' + reabiertos + ' bloques activos, ' + cerrados + ' cerrados');
    } catch (err) {
        console.error('❌ Error escanearChatters:', err);
    }
}

function msHastaProximoScan() {
    const ahora = new Date();
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    const minutosTotales = arg.getHours() * 60 + arg.getMinutes() + arg.getSeconds() / 60;
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
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    console.log('👁️ Próximo scan de chatters en ' + mins + 'm ' + secs + 's');
    setTimeout(async () => {
        try { await escanearChatters('lenno_ap'); }
        catch (e) { console.error('Error scan:', e); }
        programarProximoScan();
    }, ms);
}
async function lurkChequeoPeriodico() {
    try {
        const hoy = getFechaHoy();
        const { data: activosPre } = await supabase.from('lurk_stats')
            .select('username, lurk_join_actual, lurk_ultimo_dia')
            .not('lurk_join_actual', 'is', null);
        if (activosPre) {
            for (const a of activosPre) {
                if (a.lurk_ultimo_dia !== hoy) {
                    await lurkCerrarBloque(a.username);
                    await updateLurkStats(a.username, {
                        lurk_ultimo_dia: hoy,
                        lurk_minutos_hoy: 0,
                        lurk_puntos_hoy: 0,
                        lurk_postas_hoy: 0,
                        lurk_npc_pendiente: 0,
                        lurk_npc_canjeado_hoy: false,
                        lurk_rango_inicio: null
                    });
                    console.log('🌅 Reset diario de lurk para ' + a.username);
                }
            }
        }
        const canales = await getCanales();
        for (const c of canales) {
            if (!c.bot_activo) continue;
            const live = await checkLiveHelix(c.canal);
            if (!live) continue;
            let liveMin = c.live_minutos_hoy || 0;
            if (c.ultimo_dia_live !== hoy) liveMin = 0;
            liveMin += 5;
            const updateC = { live_minutos_hoy: liveMin, ultimo_dia_live: hoy };
            if (liveMin >= LURK_LIVE_MINIMO_2H && c.dia_contado_2h !== hoy) {
                updateC.dia_contado_2h = hoy;
                console.log('📺 Día con stream contado: ' + c.canal + ' → ' + hoy);
            }
            await updateCanal(c.canal, updateC);
        }
        await limpiarHistorialViejo();
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
    if (MODO_TESTEO_LURK) return;
    if (npcUltimoAnuncio) {
        const desdeUlt = Date.now() - new Date(npcUltimoAnuncio).getTime();
        if (desdeUlt < 55 * 60 * 1000) return;
    }
    const { data: todos } = await supabase.from('npcs').select('nombre');
    if (!todos || todos.length === 0) return;
    const disponibles = todos.filter(n => !npcUsadosCiclo.includes(n.nombre));
    if (disponibles.length === 0) return;
    const elegido = disponibles[Math.floor(Math.random() * disponibles.length)];
    npcActual = elegido.nombre;
    npcUsadosCiclo.push(npcActual);
    npcUltimoAnuncio = new Date().toISOString();
    npcVentanaHasta = new Date(Date.now() + NPC_VENTANA_MINUTOS * 60000).toISOString();
    await guardarEstadoNpc();
    const canales = await getCanales();
    const msg = '👁️ Tu Haki de Observación percibe algo... ¡Es ' + npcActual + '! Susurrá !personaje ' + npcActual.toLowerCase() + ' en los próximos ' + NPC_VENTANA_MINUTOS + ' minutos.';
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
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    const minutos = arg.getMinutes();
    const segundos = arg.getSeconds();
    let minsFaltantes;
    if (minutos < 30) minsFaltantes = 30 - minutos;
    else minsFaltantes = 60 - minutos + 30;
    return minsFaltantes * 60000 - segundos * 1000;
}

async function programarProximoNpc() {
    if (MODO_TESTEO_LURK) return;
    const ms = msHastaProximoMedia();
    console.log('👁️ Próximo anuncio NPC en ' + Math.round(ms / 60000) + ' min');
    setTimeout(async () => {
        try { await anunciarNpc(); }
        catch (e) { console.error('Error NPC:', e); }
        programarProximoNpc();
    }, ms);
}

async function procesarPersonaje(username, nombreIngresado, fromUserId) {
    if (MODO_TESTEO_LURK) return;
    if (!npcActual) { await sendWhisper(fromUserId, '⏳ No hay ningún avistamiento activo ahora.'); return; }
    if (!npcVentanaHasta || new Date(npcVentanaHasta) < new Date()) {
        await sendWhisper(fromUserId, '⏳ Ya pasó la ventana de reclamo.'); return;
    }
    const lurk = await getLurkStats(username);
    if (!lurk) return;
    if (lurk.lurk_npc_canjeado_hoy) {
        await sendWhisper(fromUserId, 'Ya reclamaste tu avistamiento de hoy. Volvé mañana.'); return;
    }
    const ingresado = nombreIngresado.toLowerCase().trim();
    const correcto = npcActual.toLowerCase().trim();
    if (ingresado === correcto) {
        await updateLurkStats(username, { lurk_npc_canjeado_hoy: true });
        if ((lurk.lurk_postas_hoy || 0) >= 3) {
            await agregarPuntosObservacion(username, 3, 0);
            await updateLurkStats(username, { lurk_puntos_hoy: (lurk.lurk_puntos_hoy || 0) + 3 });
            console.log('👁️ NPC canjeado: ' + username + ' → acierto (+3, inmediato)');
            await sendWhisper(fromUserId, '🎯 ¡Correcto! +3 de Haki de Observación.');
        } else {
            await updateLurkStats(username, { lurk_npc_pendiente: 3 });
            console.log('👁️ NPC canjeado: ' + username + ' → acierto (+3, pendiente)');
            await sendWhisper(fromUserId, '🎯 ¡Correcto! +3 pendientes. Se acreditan al completar tus 3 postas del día.');
        }
    } else {
        await updateLurkStats(username, { lurk_npc_canjeado_hoy: true });
        await agregarPuntosObservacion(username, -5, 0);
        console.log('👁️ NPC canjeado: ' + username + ' → fallo (-5)');
        await sendWhisper(fromUserId, '❌ Ese no era. -5 de Haki de Observación.');
    }
}

// ═══════════════════════════════════════════════════════════
// CONTINÚA EN PARTE 2
// ═══════════════════════════════════════════════════════════

// ============================================
// AYUDA
// ============================================
const AYUDA_MENU = '📖 AYUDA - op_d_bot — ¿Qué querés ver? 💬 !ayudachat → Comandos de chat 📩 !ayudasusurro → Comandos de susurro';
const AYUDA_CHAT = '💬 COMANDOS DE CHAT 🎮 !op → Entrena Haki 📊 !infoop → Tu info 🍎 !fruta → Busca fruta 😋 !comer / ❌ !rechazar ⚔️ !retar @usuario → Duelo ✅ !aceptarduelo / ❌ !rechazarduelo 🏆 !historial @usuario 🔴 !offop / 🟢 !onop';
const AYUDA_SUSURRO = '📩 COMANDOS DE SUSURRO 🗺️ !explorar ➡️ !continuar / ⬅️ !retroceder ⚔️ !combatir / 🏃 !retirarse ⏳ !exploracionpendiente ⚔️ !duelopendiente 📊 !infoop 👤 !infoop @usuario 🔄 !actualizacion 📡 !observacion 📡 !canaleson 👁️ !personaje <nombre>';

// ============================================
// CLIENTE
// ============================================
const client = new tmi.Client({
    options: { debug: false },
    identity: { username: config.botName, password: config.oauth },
    channels: [config.channelName, 'op_d_bot', 'lenno_ap']
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
        await lurkPart(username.toLowerCase());
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
            if (u && u.twitch_user_id !== twitchUserId) {
                await updateUsuario(fromUser.toLowerCase(), { twitch_user_id: twitchUserId });
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
        if (response.status === 204) {
            console.log('✅ Susurro → ' + toUserId + ': ' + message.replace(/\n/g, ' | '));
        } else {
            console.error('❌ Error susurro: ' + response.status, await response.text());
        }
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
    const command = normalizarComando(args[0]);
    const username = fromUserLogin.toLowerCase();

    if (!fromUserId) return;
    if (!command.startsWith('!')) return;

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
    // !scan (solo dueño)
    if (command === '!scan') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        await sendWhisper(fromUserId, '⏳ Escaneando chatters...');
        await escanearChatters('lenno_ap');
        await sendWhisper(fromUserId, '✅ Scan completado. Revisá los logs.');
        return;
    }

    // !deploy (solo dueño)
    if (command === '!deploy') {
        if (username !== DUEÑO) {
            await sendWhisper(fromUserId, '❌ No tenés permiso para usar este comando.');
            return;
        }
        const { data: abiertos } = await supabase.from('lurk_stats')
            .select('username').not('lurk_join_actual', 'is', null);
        let cerrados = 0;
        if (abiertos) {
            for (const a of abiertos) {
                await lurkCerrarBloque(a.username);
                cerrados++;
            }
        }
        console.log('🚀 Deploy preparado. Bloques cerrados: ' + cerrados);
        await sendWhisper(fromUserId, '✅ Listo para el deploy. Bloques cerrados: ' + cerrados + '. Podés proceder.');
        return;
    }

    // !observacion
    if (command === '!observacion') {
        if (!cooldownsLurk[username]) cooldownsLurk[username] = {};
        if (cooldownsLurk[username].observacion && Date.now() - cooldownsLurk[username].observacion < 30000) {
            await sendWhisper(fromUserId, '⏳ Esperá unos segundos.'); return;
        }
        cooldownsLurk[username].observacion = Date.now();
        const lurkCheck = await getLurkStats(username);
        if (lurkCheck && !lurkCheck.lurk_join_actual && lurkCheck.lurk_ultimo_dia === getFechaHoy()) {
            await updateLurkStats(username, { lurk_join_actual: new Date().toISOString() });
            console.log('👁️ Bloque reabierto por !observacion: ' + username);
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

    // !personaje X
    if (command === '!personaje') {
        if (MODO_TESTEO_LURK) { await sendWhisper(fromUserId, '⏳ El avistamiento todavía no está activo.'); return; }
        if (!args[1]) { await sendWhisper(fromUserId, 'Uso: !personaje <nombre>'); return; }
        await procesarPersonaje(username, args[1], fromUserId);
        return;
    }

    if (command === '!infoop' && !args[1]) {
        const user = await getUsuario(username);
        if (!user) { await sendWhisper(fromUserId, 'Error al obtener datos.'); return; }
        const supArm = await esSupremoArmadura(username);
        const supObs = await esSupremoObservacion(username);
        const supConq = await esSupremoConquistador(username);
        let frutaTexto = '🍎 Ninguna';
        if (user.fruta) {
            const { data: f } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = '🍎 ' + user.fruta + ' ' + ((f && f.emoji) || '');
        }
        const rangoArm = getRangoArmadura(user.armadura || 0, supArm);
        const rangoObs = getRangoObservacion(user.observacion || 0, supObs);
        const rangoConq = getRangoConquistador(user.conquistador || 0, supConq);
        let estadoExplorar = 'disponible';
        if (user.evento_explorar_estado === 'pendiente') estadoExplorar = 'pendiente';
        else {
            const cd = await puedeExplorar(user);
            if (!cd.ok) estadoExplorar = 'usada. Próxima en ' + formatTiempoRestante(cd.restante);
        }
        const recompensaBase = calcularRecompensa(user);
        const recompensaReal = recompensaBase + Math.max(0, user.recompensa_delta || 0);
        const mensaje = '📊 Tus stats: ' + frutaTexto + ' | 🛡️ ' + rangoArm.nombre + ' (' + (user.armadura || 0) + ') ' + rangoArm.emoji + ' | 👁️ ' + rangoObs.nombre + ' (' + (user.observacion || 0) + ') ' + rangoObs.emoji + ' | ⚜️ ' + rangoConq.nombre + ' (' + (user.conquistador || 0) + ') ' + rangoConq.emoji + ' | 🏴‍☠️💰 $' + recompensaReal.toLocaleString('es-AR') + ' | 🗺️ ' + estadoExplorar;
        await sendWhisper(fromUserId, mensaje);
        return;
    }

    if (command === '!infoop' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target);
        if (!targetUser) { await sendWhisper(fromUserId, 'No encontré a @' + target); return; }
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
        await sendWhisper(fromUserId, '@' + target + ' | ' + frutaTexto + ' | 🛡️:' + eArm + ' | 👁️:' + eObs + ' | ⚜️:' + eConq + ' | 🏴‍☠️💰 $' + (targetUser.recompensa_publica || 0).toLocaleString('es-AR'));
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
            await sendWhisper(fromUserId, fruta.fase2 + ' ' + getCalaverasPorProb(0.5) + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' ⚔️ ' + (fruta.ataque || 0) + ' | 🛡️ ' + (fruta.defensa || 0) + ' | 🧠 ' + (fruta.utilidad || 0) + ' — ⚔️ !pelear o 🏃 !huir');
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
                const o = user.evento_explorar_opciones || {};
                let msg = '⏳ Ya tenés exploración en curso:';
                if (o.facil) msg += ' 🟢 !facil ' + getCalaverasPorProb(o.facil.prob);
                if (o.medio) msg += ' 🟡 !medio ' + getCalaverasPorProb(o.medio.prob);
                if (o.dificil) msg += ' 🔴 !dificil ' + getCalaverasPorProb(o.dificil.prob);
                await sendWhisper(fromUserId, msg); return;
            }
            const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
            if (!npc) { await sendWhisper(fromUserId, 'Error.'); return; }
            const o = user.evento_explorar_opciones || {};
            const op = o[user.evento_explorar_dificultad];
            if (user.evento_explorar_fase === 'avistamiento') {
                await sendWhisper(fromUserId, '📍 Pendiente. ' + npc.fase1 + ' — ➡️ !continuar o ⬅️ !retroceder');
            } else {
                await sendWhisper(fromUserId, '📍 Pendiente. ' + npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' — ⚔️ !combatir o 🏃 !retirarse');
            }
            return;
        }
        const cd = await puedeExplorar(user);
        if (!cd.ok) { await sendWhisper(fromUserId, '⏳ Próxima en ' + formatTiempoRestante(cd.restante)); return; }
        const pcfUsuario = await calcularPCFUsuario(user);
        const opciones = await seleccionarNPCs(pcfUsuario);
        if (!opciones) { await sendWhisper(fromUserId, '🗺️ No encontrás rivales. Volvé más tarde.'); return; }
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
        if (f) msg += ' 🟢 !facil ' + getCalaverasPorProb(f.prob) + ' (+' + f.recompensa_conq + ' Conq / +$' + f.recompensa_berries.toLocaleString('es-AR') + ')';
        if (m) msg += ' 🟡 !medio ' + getCalaverasPorProb(m.prob) + ' (+' + m.recompensa_conq + ' Conq / +$' + m.recompensa_berries.toLocaleString('es-AR') + ')';
        if (d) msg += ' 🔴 !dificil ' + getCalaverasPorProb(d.prob) + ' (+' + d.recompensa_conq + ' Conq / +$' + d.recompensa_berries.toLocaleString('es-AR') + ')';
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
        await sendWhisper(fromUserId, npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' ⚔️ !combatir o 🏃 !retirarse');
        return;
    }

    if (command === '!retroceder') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, 'No estás en avistamiento.'); return;
        }
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        const castigo = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigo, 0),
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        });
        const msg = await getTextoExplorar('retroceder');
        await sendWhisper(fromUserId, msg + ' -' + castigo + ' Conq.');
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
        console.log('🗺️ Explorar: ' + username + ' → ' + (op.victoria ? 'victoria' : 'derrota') + ' vs ' + op.npc + ' (PCF ' + op.pcf_usuario + ' vs ' + op.pcf_npc + ')');
        if (op.victoria) {
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
        const o = user.evento_explorar_opciones || {};
        const op = o[user.evento_explorar_dificultad];
        const castigo = Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
        await updateUsuario(username, {
            conquistador: Math.max((user.conquistador || 0) - castigo, 0),
            evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
            evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
            evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
        });
        const msg = await getTextoExplorar('retirarse');
        await sendWhisper(fromUserId, msg + ' -' + castigo + ' Conq.');
        return;
    }

    if (command === '!exploracionpendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente') {
            await sendWhisper(fromUserId, 'No tenés exploración pendiente.'); return;
        }
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
            await sendWhisper(fromUserId, '📍 ' + npc.fase2 + ' ' + getCalaverasPorProb(op.prob) + ' ⚔️ !combatir o 🏃 !retirarse');
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
        const netoTxt = h.neto > 0 ? 'le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'le perdiste $' + formatBerries(Math.abs(h.neto)) : 'están a mano';
        await sendWhisper(fromUserId, '📊 vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }
}

// ============================================
// MOSTRAR OBSERVACIÓN
// ============================================
async function mostrarObservacion(username, fromUserId) {
    const user = await getUsuario(username);
    if (!user) return;
    const lurk = await getLurkStats(username);
    if (!lurk) { await sendWhisper(fromUserId, 'Error.'); return; }
    const supObs = await esSupremoObservacion(username);
    const rango = getRangoObservacion(user.observacion || 0, supObs);
    const postas = lurk.lurk_postas_hoy || 0;
    const minutos = lurk.lurk_minutos_hoy || 0;
    const ptsHoy = lurk.lurk_puntos_hoy || 0;
    const racha = lurk.lurk_racha || 0;
    const bonusRacha = racha > 0 ? calcularBonusRacha(racha) : 0;
    let avistamiento = '❌ no reclamado';
    if (lurk.lurk_npc_canjeado_hoy) {
        avistamiento = (lurk.lurk_npc_pendiente > 0) ? '⏳ pendiente (te faltan postas)' : '✅ reclamado';
    }
    let faltan = '';
    if (postas < 3) faltan = 'Faltan: ' + (3 - postas) + ' posta' + (postas === 2 ? '' : 's') + ' para completar el día';
    else faltan = '¡Día completo!';
    const msg = '📡 Haki de Observación\n' +
        '🚩 Postas hoy: ' + postas + '/3 (' + minutos + ' min)\n' +
        '📈 Puntos hoy: +' + ptsHoy + '\n' +
        '🔥 Racha: ' + racha + ' día' + (racha === 1 ? '' : 's') + (bonusRacha > 0 ? ' (bonus +' + bonusRacha + ')' : '') + '\n' +
        '🔭 Avistamiento: ' + avistamiento + '\n' +
        '⏳ ' + faltan + '\n' +
        '👁️ Rango: ' + rango.emoji + ' ' + rango.nombre + ' (' + (user.observacion || 0) + ')';
    await sendWhisper(fromUserId, msg);
}

// ============================================
// RETAR
// ============================================
async function procesarRetar(username, targetRaw, fromUserId, esSusurro, chatChannel) {
    const target = targetRaw.replace('@', '').toLowerCase();
    const responder = async (msg) => {
        if (esSusurro) await sendWhisper(fromUserId, msg);
        else client.say(chatChannel, '@' + username + ' ' + msg);
    };
    if (target === username) { await responder('No podés retarte a vos mismo.'); return; }
    const targetUser = await getUsuario(target);
    if (!targetUser) { await responder('@' + target + ' no está registrado.'); return; }
    const user = await getUsuario(username);
    if (!user) return;
    if (user.evento_duelo_estado === 'pendiente') {
        const otro = user.evento_duelo_retador === username ? user.evento_duelo_retado : user.evento_duelo_retador;
        await responder('Ya tenés un duelo pendiente con @' + otro + '.'); return;
    }
    if (user.evento_explorar_estado === 'pendiente' || user.evento_fruta_estado === 'pendiente') {
        await responder('Tenés un evento pendiente. Resolvelo antes.'); return;
    }
    if (!(await completoExplorarHoy(username))) { await responder('Necesitás completar tu !explorar del día.'); return; }
    if ((user.recompensa_delta || 0) < DUELO_DELTA_MINIMO) { await responder('Necesitás $100M+ de recompensa para retar.'); return; }
    if (user.ultimo_duelo_timestamp) {
        const diff = Date.now() - new Date(user.ultimo_duelo_timestamp).getTime();
        if (diff < DUELO_COOLDOWN_MS) { await responder('Esperá ' + Math.ceil((DUELO_COOLDOWN_MS - diff) / 60000) + ' min.'); return; }
    }
    if ((await contarDuelosHoy(username)) >= DUELO_LIMITE_DIARIO) { await responder('Ya usaste tus 5 duelos de hoy.'); return; }
    if ((await contarDuelosHoyEntre(username, target)) >= DUELO_LIMITE_PAREJA) { await responder('Ya se enfrentaron 3 veces hoy.'); return; }
    if (await fueRechazadoHoy(username, target)) { await responder('@' + target + ' ya te rechazó hoy.'); return; }
    if (targetUser.evento_duelo_estado === 'pendiente') { await responder('@' + target + ' ya tiene duelo pendiente.'); return; }
    if (targetUser.evento_explorar_estado === 'pendiente' || targetUser.evento_fruta_estado === 'pendiente') {
        await responder('@' + target + ' está en medio de un evento.'); return;
    }
    if ((targetUser.recompensa_delta || 0) < DUELO_DELTA_MINIMO) { await responder('@' + target + ' no tiene $100M+ para duelar.'); return; }
    if (!(await completoExplorarHoy(target))) { await responder('@' + target + ' no completó su !explorar del día.'); return; }
    const pcfRetador = await calcularPCFUsuario(user);
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
    if (!esSusurro) {
        client.say(chatChannel, '⚔️ @' + target + ', @' + username + ' te ha retado. Tenés 2 minutos para !aceptarduelo o !rechazarduelo.');
    }
    if (targetUser.twitch_user_id) {
        try {
            await sendWhisper(targetUser.twitch_user_id, '⚔️ @' + username + ' te ha retado a un duelo. Tenés 2 minutos para responder con !aceptarduelo o !rechazarduelo.');
        } catch (e) { console.error('Error notif reto:', e); }
    }
    if (esSusurro) await sendWhisper(fromUserId, '⚔️ Reto enviado a @' + target + '.');
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
        const pcfPerd = ganador === retador ? pcfRetado : pcfRetador;
        const pcfGan = ganador === retador ? pcfRetador : pcfRetado;
        monto = Math.round(calcularMontoDuelo(perdedorUser.recompensa_delta || 0, pcfPerd, pcfGan));
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
    console.log('⚔️ Duelo resuelto: ' + retador + ' vs ' + retado + ' → ' + (empate ? 'empate' : ganador) + ' (monto: ' + monto + ')');
    const textoBase = await getTextoDuelo(situacion);
    const perdedor = empate ? '' : (ganador === retador ? retado : retador);
    const texto = aplicarPlaceholders(textoBase, {
        retador, retado, ganador: ganador || '', perdedor,
        monto: monto > 0 ? formatBerries(monto) : '0'
    });
    client.say('op_d_bot', texto);
    if (retadorUser.twitch_user_id) { try { await sendWhisper(retadorUser.twitch_user_id, '⚔️ ' + texto); } catch (e) { console.error('Error notif duelo retador:', e); } }
    if (retadoUser.twitch_user_id) { try { await sendWhisper(retadoUser.twitch_user_id, '⚔️ ' + texto); } catch (e) { console.error('Error notif duelo retado:', e); } }
    if (esSusurro) await sendWhisper(fromUserId, '⚔️ Duelo resuelto. ' + texto);
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
    if (retadorUser && retadorUser.twitch_user_id) {
        try {
            const t = await getTextoDuelo('rechazo');
            await sendWhisper(retadorUser.twitch_user_id, '❌ ' + aplicarPlaceholders(t, { retador, retado, monto: '0' }));
        } catch (e) { console.error('Error notif rechazo:', e); }
    }
}

// ============================================
// COMANDOS DE CHAT
// ============================================
client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    if (channel.startsWith('##')) return;
    if (tags['message-type'] === 'whisper') return;

    const args = message.trim().split(' ');
    const command = normalizarComando(args[0]);
    const username = tags.username.toLowerCase();
    const twitchUserId = tags['user-id'];
    const canal = channel.replace('#', '').toLowerCase();

    if (!command.startsWith('!')) return;

    const canalDb = await getCanal(canal);
    const botActivo = canalDb ? canalDb.bot_activo : true;

    if (!botActivo && command !== '!onop') return;

    // !onop / !offop
    if (command === '!onop' || command === '!offop') {
        if (!esModOCaster(tags)) return;
        if (cooldownsOnOff[canal] && Date.now() - cooldownsOnOff[canal] < 5 * 60 * 1000) {
            client.say(channel, '⏳ Esperá 5 minutos antes de volver a cambiar el estado del bot.');
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

    if (canal === 'lenno_ap') return;

    console.log('💬 [' + canal + '] ' + username + ': ' + message);

    if (twitchUserId) {
        try {
            const u = await getUsuario(username);
            if (u && u.twitch_user_id !== twitchUserId) {
                await updateUsuario(username, { twitch_user_id: twitchUserId });
            }
        } catch (e) { console.error('Error guardando user_id:', e); }
    }

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
        const netoTxt = h.neto > 0 ? 'le ganaste $' + formatBerries(h.neto) : h.neto < 0 ? 'le perdiste $' + formatBerries(Math.abs(h.neto)) : 'están a mano';
        client.say(channel, '📊 @' + username + ' vs @' + target + ': ' + h.total + ' duelos (' + h.ganadosA + '/' + h.empates + '/' + h.ganadosB + '). ' + netoTxt + '.');
        return;
    }

    if (command === '!infoop') {
        if (args[1]) { client.say(channel, '@' + tags.username + ' Por susurro, máquina 📩'); return; }
        const user = await getUsuario(username);
        if (!user) { client.say(channel, '@' + tags.username + ' Error.'); return; }
        const supArm = await esSupremoArmadura(username);
        const supObs = await esSupremoObservacion(username);
        const supConq = await esSupremoConquistador(username);
        const recompensaBase = calcularRecompensa(user);
        const recompensaReal = recompensaBase + Math.max(0, user.recompensa_delta || 0);
        await updateUsuario(username, { recompensa_publica: recompensaReal });
        let frutaTexto = '🍎 Ninguna';
        if (user.fruta) {
            const { data: f } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = '🍎 ' + user.fruta + ' ' + ((f && f.emoji) || '');
        }
        const eArm = getRangoArmadura(user.armadura || 0, supArm).emoji;
        const eObs = getRangoObservacion(user.observacion || 0, supObs).emoji;
        const eConq = getRangoConquistador(user.conquistador || 0, supConq).emoji;
        client.say(channel, '@' + username + ' | ' + frutaTexto + ' | 🛡️:' + eArm + ' | 👁️:' + eObs + ' | ⚜️:' + eConq + ' | 🏴‍☠️💰 $' + recompensaReal.toLocaleString('es-AR'));
        return;
    }

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
        let msgPenalizacion = null;
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
                if (delta !== 0) msgPenalizacion = '💤 Descuidaste. -' + Math.abs(delta) + ' Armadura.';
                await updateUsuario(username, { armadura: arm, op_usos_hoy: 0, ultimo_op_fecha: hoy, racha_ops: 0 });
            } else {
                await updateUsuario(username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
            }
        }
        const userAct = await getUsuario(username);
        if ((userAct.op_usos_hoy || 0) >= 3) { client.say(channel, 'Límite diario alcanzado.'); return; }
        const armActual = userAct.armadura || 0;
        const eraSupremo = await esSupremoArmadura(username);
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
            const bonusRacha = getBonusRachaOp(rachaActual);
            mensajesExtra.push('🔥 Racha ' + rachaActual + 'd: +' + bonusRacha);
            updateData.armadura = nuevaArm + bonusDiario + bonusRacha;
            updateData.racha_ops = rachaActual;
            updateData.ultimo_dia_racha = hoy;
        }
        await updateUsuario(username, updateData);
        const ahoraSupremo = await esSupremoArmadura(username);
        const rangoFinal = getRangoArmadura(updateData.armadura, ahoraSupremo);
        const texto = getTextoResultadoOp(rangoFinal.nombre, delta);
        let respuesta = '@' + tags.username + ' ' + texto + ' ' + (delta > 0 ? '+' : '') + delta + ' Armadura ' + rangoFinal.emoji;
        const rangoAnterior = eraSupremo ? 'Supremo' : getRangoArmadura(armActual).nombre;
        if (rangoAnterior !== rangoFinal.nombre) {
            const msg = MENSAJES_RANGO_ARMADURA[rangoFinal.nombre];
            if (msg) respuesta += ' | ' + msg;
            console.log('⬆️ Rango: ' + username + ' → Armadura ' + rangoFinal.nombre);
        }
        if (mensajesExtra.length > 0) respuesta += ' | ' + mensajesExtra.join(' | ');
        if (msgPenalizacion) respuesta = msgPenalizacion + ' | ' + respuesta;
        client.say(channel, respuesta);
        return;
    }

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
                console.log('🍎 Fruta encontrada: ' + username + ' → ' + selectedFruit.nombre + ' (evento)');
                client.say(channel, '@' + tags.username + ' ' + selectedFruit.fase1 + ' — ✅ !si o ❌ !no');
            } else {
                await updateUsuario(username, { fruta_pendiente: selectedFruit.nombre });
                console.log('🍎 Fruta encontrada: ' + username + ' → ' + selectedFruit.nombre + ' (sin evento)');
                client.say(channel, '@' + tags.username + ' ¡Encontraste la ' + selectedFruit.nombre + ' ' + (selectedFruit.emoji || '') + '! ⚔️ ' + (selectedFruit.ataque || 0) + ' | 🛡️ ' + (selectedFruit.defensa || 0) + ' | 🧠 ' + (selectedFruit.utilidad || 0) + ' — !comer o !rechazar');
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
            client.say(channel, '@' + tags.username + ' ' + fruta.fase2 + ' ' + getCalaverasPorProb(0.5) + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' ⚔️ ' + (fruta.ataque || 0) + ' | 🛡️ ' + (fruta.defensa || 0) + ' | 🧠 ' + (fruta.utilidad || 0) + ' — ⚔️ !pelear o 🏃 !huir');
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
        client.say(channel, '@' + tags.username + ' ' + fruta.fase2 + ' ' + getCalaverasPorProb(0.5) + ' 🍎 ' + fruta.nombre + ' ' + (fruta.emoji || '') + ' ⚔️ ' + (fruta.ataque || 0) + ' | 🛡️ ' + (fruta.defensa || 0) + ' | 🧠 ' + (fruta.utilidad || 0) + ' — ⚔️ !pelear o 🏃 !huir');
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
        const supArm = await esSupremoArmadura(username);
        const supObs = await esSupremoObservacion(username);
        const supConq = await esSupremoConquistador(username);
        const poderUsuario = poderFrutaUsuario
            + calcularAporteArmadura(user.armadura || 0, supArm)
            + calcularAporteObservacion(user.observacion || 0, supObs)
            + calcularAporteConquistador(user.conquistador || 0, supConq);
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
        const mensaje = obtenerMensajeCombate(resultado.victoria, resultado.porcentaje);
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
                for (const a of afectados) {
                    await updateUsuario(a.username, { evento_fruta_comida_por_otro: true });
                    console.log('🍎 Fruta perdida: ' + a.username + ' perdió evento de ' + user.evento_fruta_nombre);
                }
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
            console.log('🍎 Fruta consumida: ' + username + ' → ' + user.fruta_pendiente);
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

    // ADMIN
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
        console.log('🔧 Admin: ' + username + ' ' + (info.signo > 0 ? 'sumó' : 'restó') + ' ' + cantidad + ' ' + info.nombre + ' a ' + target);
        client.say(channel, '@' + tags.username + ' ' + (info.signo > 0 ? 'Sumado' : 'Restado') + ' ' + cantidad + ' ' + info.nombre + ' a @' + target + '. Ahora: ' + nuevo);
        return;
    }
    if (command === '!quitarfruta') {
        if (args.length < 2) return client.say(channel, '@' + tags.username + ' Uso: !quitarfruta @usuario');
        const target = args[1].replace('@', '').toLowerCase();
        await updateUsuario(target, { fruta: null, fruta_pendiente: null });
        console.log('🔧 Admin: ' + username + ' quitó fruta a ' + target);
        client.say(channel, '@' + tags.username + ' Fruta quitada a @' + target + '.'); return;
    }
});

// ============================================
// INICIALIZACIÓN
// ============================================
cargarCommitInfo().then(() => console.log('📦 Commit info cargado.'));
cargarEstadoNpc().then(() => {
    console.log('👁️ Estado NPC cargado.');
    programarProximoNpc();
});
setInterval(ejecutarTimeoutDuelos, 60 * 1000);
setInterval(lurkChequeoPeriodico, 5 * 60 * 1000);

// Scan inicial de chatters + programación de scans :01, :21, :41
setTimeout(async () => {
    try { await escanearChatters('lenno_ap'); }
    catch (e) { console.error('Error scan inicial:', e); }
    programarProximoScan();
}, 15000);

console.log('Bot escuchando...');