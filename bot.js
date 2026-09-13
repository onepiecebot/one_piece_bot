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

const MODO_COOLDOWN = 'prueba'; // 'prueba' o 'produccion'
const COOLDOWN_EXPLORAR_PRUEBA = 30 * 1000; // 30 segundos
const COOLDOWN_EXPLORAR_PRODUCCION = 24 * 60 * 60 * 1000; // 24 horas

// ============================================
// COOLDOWNS (en memoria)
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
// CÁLCULO DE RECOMPENSA
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
    if (ahora - supremosCache.timestamp < SUPREMOS_CACHE_TTL) return supremosCache.data;
    try {
        const { data: dedicadosData, error: err1 } = await supabase
            .from('usuarios').select('username').gt('op_usos_hoy', 0);
        if (err1) return [];
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
                .update({ supremos_min_historico: plazasBase }).eq('username', DUEÑO);
        }
        const plazasBaseEfectivas = Math.max(plazasBase, minHistorico);
        let totalPlazas = numDedicados === 0
            ? Math.max(plazasExtra, minHistorico)
            : Math.max(plazasBaseEfectivas, plazasExtra + 1);
        if (totalPlazas === 0) {
            supremosCache = { data: [], timestamp: ahora };
            return [];
        }
        const { data: topData } = await supabase
            .from('usuarios').select('username, armadura')
            .gte('armadura', 100).order('armadura', { ascending: false }).limit(totalPlazas);
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
// SISTEMA DE COMBATE
// ============================================
function calcularPoderHakis(armadura, observacion, conquistador, esSupremoArmadura = false) {
    const factorArmadura = esSupremoArmadura ? 1.0 : (armadura <= 19 ? 0 : armadura <= 49 ? 0.2 : armadura <= 79 ? 0.5 : armadura <= 99 ? 0.8 : 1.0);
    const factorObservacion = observacion <= 19 ? 0 : observacion <= 49 ? 0.2 : observacion <= 79 ? 0.5 : observacion <= 99 ? 0.8 : 1.0;
    let aporteConquistador = 0;
    if (conquistador >= 60 && conquistador <= 79) aporteConquistador = 100;
    else if (conquistador >= 80 && conquistador <= 94) aporteConquistador = 150;
    else if (conquistador >= 95 && conquistador <= 100) aporteConquistador = 250;
    else if (conquistador > 100) aporteConquistador = 400;
    return (armadura * factorArmadura * 2.5) + (observacion * factorObservacion * 1.8) + aporteConquistador;
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
        porcentaje: (diferencia / pfE) * 100,
        poderFinalUsuario: pfU, poderFinalEnemigo: pfE
    };
}

function obtenerMensaje(victoria, porcentaje) {
    const cat = victoria ? 'victoria' : 'derrota';
    const absP = Math.abs(porcentaje);
    let rango = absP > 50 ? 'aplastante' : absP >= 20 ? 'clara' : absP >= 5 ? 'ajustada' : 'por_los_pelos';
    const mensajes = {
        victoria: {
            aplastante: ['¡VICTORIA ARROLLADORA! Tu poder es abrumador. El enemigo apenas puede mantenerse en pie antes de caer derrotado.', '¡HAS DEVASTADO A TU RIVAL! Cada golpe era una sentencia.'],
            clara: ['¡VICTORIA CONTUNDENTE! Has dominado el combate de principio a fin.', '¡TRIUNFO SIN DISCUSIÓN! Te has impuesto con autoridad.'],
            ajustada: ['¡VICTORIA SUDADA! Has ganado, pero no ha sido fácil.', '¡VICTORIA POR LOS JUSTOS! El combate ha sido igualado, pero tu determinación ha sido mayor.'],
            por_los_pelos: ['¡VICTORIA AGÓNICA! Literalmente has ganado por un pelo.', '¡VICTORIA MILAGROSA! Has ganado por centímetros.']
        },
        derrota: {
            aplastante: ['DERROTA ANIQUILADORA. El enemigo te ha superado con una facilidad pasmosa.', 'HAS SIDO BARRIDO. Tu oponente era de otro nivel.'],
            clara: ['DERROTA CLARA. Has luchado con valor, pero el enemigo ha sido claramente superior.', 'DERROTA SIN PALIATIVOS. Has dado todo, pero el rival ha sido demasiado fuerte hoy.'],
            ajustada: ['DERROTA AJUSTADA. Has estado a punto de ganar.', 'DERROTA POR POCO. Has peleado bien, pero te ha faltado un último esfuerzo.'],
            por_los_pelos: ['DERROTA POR LOS PELOS. Has perdido por un suspiro.', 'DERROTA INEXTREMIS. Has estado a punto de ganar.']
        }
    };
    const pool = mensajes[cat][rango] || mensajes[cat]['ajustada'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================
// SISTEMA DE EXPLORACIÓN
// ============================================
function calcularProbabilidadVictoria(pcfUser, pcfNpc) {
    return 1 / (1 + Math.exp(5 * ((pcfNpc / pcfUser) - 1)));
}

function getBucket(prob) {
    if (prob >= 0.65 && prob <= 0.95) return 'facil';
    if (prob >= 0.21 && prob <= 0.64) return 'medio';
    if (prob >= 0.05 && prob <= 0.20) return 'dificil';
    return null;
}

function getEscalon(ratio) {
    if (ratio >= 1.5) return 'mucho_mas_fuerte';
    if (ratio >= 1.25) return 'mas_fuerte';
    if (ratio >= 0.75) return 'parejo';
    if (ratio >= 0.5) return 'mas_debil';
    return 'mucho_mas_debil';
}

function getMargenKey(margen) {
    if (margen < 0.10) return 'bajo';
    if (margen < 0.30) return 'medio';
    return 'alto';
}

const MODIF_VICTORIA = {
    mucho_mas_fuerte: { bajo: 0.50, medio: 0.55, alto: 0.60 },
    mas_fuerte:       { bajo: 0.75, medio: 0.80, alto: 0.85 },
    parejo:           { bajo: 1.00, medio: 1.10, alto: 1.20 },
    mas_debil:        { bajo: 1.15, medio: 1.35, alto: 1.60 },
    mucho_mas_debil:  { bajo: 1.30, medio: 1.55, alto: 2.00 }
};

const MODIF_DERROTA = {
    mucho_mas_fuerte: { bajo: 1.30, medio: 1.55, alto: 2.00 },
    mas_fuerte:       { bajo: 1.15, medio: 1.35, alto: 1.60 },
    parejo:           { bajo: 1.00, medio: 1.10, alto: 1.20 },
    mas_debil:        { bajo: 0.75, medio: 0.80, alto: 0.85 },
    mucho_mas_debil:  { bajo: 0.50, medio: 0.55, alto: 0.60 }
};

const MULT_DIFICULTAD = {
    facil:   { victoria: 0.5, derrota: 1.8 },
    medio:   { victoria: 1.0, derrota: 1.0 },
    dificil: { victoria: 1.8, derrota: 0.5 }
};

function redondearBerries(valor) {
    return Math.round(valor / 10000) * 10000;
}

function redondearConquistador(valor, esCastigo = false) {
    if (esCastigo) return Math.max(Math.ceil(valor), 1);
    return Math.max(Math.round(valor), 1);
}

function calcularRecompensasExplorar(npc, dificultad, escalon, margenKey, victoria) {
    const baseConq = npc.recompensa_conquistador || 0;
    const baseBerries = npc.recompensa_berries || 0;
    const mult = MULT_DIFICULTAD[dificultad];

    if (victoria) {
        const mod = MODIF_VICTORIA[escalon][margenKey];
        return {
            conq: redondearConquistador(baseConq * mod * mult.victoria),
            berries: redondearBerries(baseBerries * mod * mult.victoria)
        };
    } else {
        const mod = MODIF_DERROTA[escalon][margenKey];
        return {
            conq: redondearConquistador(baseConq * mod * 0.70 * mult.derrota, true),
            berries: redondearBerries(baseBerries * mod * 0.70 * mult.derrota)
        };
    }
}

// ============================================
// MENSAJES CONTEXTUALES DE EXPLORACIÓN
// ============================================
const MENSAJES_VICTORIA = {
    underdog_goleada: [
        'El destino te daba como perdedor, pero… parece que el destino no te conocía.',
        'El destino te daba como perdedor, pero… acá estás. Con la sombra de {npc} a tus pies.',
        'Donde todos veían una derrota anunciada, vos viste una oportunidad. Y la aprovechaste sin piedad.',
        'Que quede claro para siempre: hoy, el más débil ganó. Y no fue por poco.',
        'La historia la escriben los que ganan. Y hoy, la pluma fue tuya.'
    ],
    underdog_poco: [
        'Casi no la contás. El rival era más fuerte, pero hoy la suerte jugó de tu lado.',
        'Ganaste raspando. Pero raspando o no, la victoria es tuya y de nadie más.',
        'No fue una victoria aplastante. Fue una victoria sufrida. Y esas saben mejor.',
        'Un paso más y perdías. Pero no diste ese paso. Ganaste vos.',
        'El rival te superaba en fuerza. Pero en voluntad, no había comparación.'
    ],
    parejo: [
        'Cuando el poder es parejo, gana el que quiere un poco más. Y hoy, ese fuiste vos.',
        'Ni más fuerte, ni más rápido. Solo más decidido. Y con eso alcanzó.',
        'Cuando dos fuerzas se encuentran, la que cede primero pierde. Hoy, el rival cedió.',
        'No fue suerte. No fue destino. Fue voluntad. Y la tuya pesó más.',
        'No hubo favoritos. No hubo excusas. Solo dos rivales y una victoria. Tuya.'
    ],
    favorito_poco: [
        'Era tu pelea. Debías ganarla fácil. Y casi la perdés. Aplausos… pero tibios.',
        'Ganaste, sí. Pero el sudor en tu frente dice otra cosa. Esto no fue una victoria limpia.',
        'No fue una derrota. Pero tampoco una victoria de las que se celebran. Fue un aviso.',
        'El papel decía que ganabas fácil. La pelea dijo otra cosa. Tomá nota para la próxima.',
        'Se llevó el triunfo. Pero también se llevó una lección: la confianza excesiva es peligrosa.'
    ],
    favorito_goleada: [
        'Sin sorpresas. El más fuerte ganó. Y el más fuerte eras vos.',
        'No hubo batalla. Hubo trámite. El rival no era rival. Y la victoria, un simple formalismo.',
        'El rival nunca tuvo chance. Y eso lo sabías desde el principio. Victoria de trámite.',
        'Ganaste sin despeinarte. El rival era inferior y lo pagó caro. A otra cosa.',
        'No hubo épica. No hubo riesgo. Solo un rival inferior y una victoria anunciada.'
    ]
};

const MENSAJES_DERROTA = {
    underdog_poco: [
        'Casi lo lográs. El rival era más fuerte, pero vos estuviste a un paso. La próxima será.',
        'Perdiste. Sí. Pero no fue una derrota cualquiera. Fue una derrota que deja enseñanzas.',
        'Un movimiento más y la historia era otra. No llegó. Pero estuvo cerca. Muy cerca.',
        'Te faltó un suspiro. Un solo suspiro. Pero eso también es parte del camino.',
        'El rival era más fuerte. Y aun así, te quedaste a las puertas. Guardá esa bronca. Va a servir.'
    ],
    underdog_aplastado: [
        'No hubo pelea. Hubo lección. El rival te mostró la distancia que todavía te separa.',
        'Te aplastaron. Sin vueltas. Guardá esto: es la medida de cuánto te falta.',
        'El rival estaba en otra liga. Y hoy, esa liga te pasó por encima. Volvé más fuerte.',
        'Sabías que iba a ser difícil. No sabías que iba a ser imposible. Tomá nota y volvé mejor.',
        'No fue tu día. Tampoco tu pelea. Tampoco tu rival. Pero el golpe te va a hacer más fuerte.'
    ],
    parejo: [
        'Pelea de iguales. Solo uno podía quedar en pie. Y esta vez, no fuiste vos.',
        'Los dos dieron todo. Los dos merecían ganar. Pero el destino eligió al otro.',
        'Igualados en fuerza. Pero la balanza se inclinó un milímetro para el otro lado. A un milímetro de la gloria...',
        'Cuando el poder es parejo, gana el que comete menos errores. Hoy, el error fue tuyo.',
        'Iguales en todo. Menos en el resultado. Y eso, a veces, es la diferencia más grande.'
    ],
    favorito_poco: [
        'Era tu pelea. Debías ganarla. Y la perdiste. No hay excusas que valgan.',
        'Se suponía que ibas a ganar. Se suponía. Pero las suposiciones no ganan peleas.',
        'No hay consuelo posible: perdiste contra alguien que no debía ganarte. Ni siquiera por poco.',
        'La diferencia era tuya. La victoria era tuya. Y las dos se escaparon por un suspiro.',
        'Perdiste lo que no debías perder. Y por poco. Guardá esta bronca, la vas a necesitar.'
    ],
    favorito_aplastado: [
        'No hay excusa. No hay consuelo. Perdiste contra alguien que no debía ganarte. Y perdiste feo.',
        'El papel decía que ganabas. La realidad dijo que no. Y la realidad fue cruel.',
        'No fue una derrota. Fue una lección de humildad. La peor clase posible.',
        'El rival era inferior en todo. Y aun así te dio vuelta la pelea. Esto se llama fracaso.',
        'La historia dirá que perdiste contra alguien más débil. Y la historia no se equivoca.'
    ]
};

const MENSAJES_RETIRARSE = [
    'Reconocer tus límites también es de sabios.',
    'Mejor vivo que valiente. La próxima será.',
    'El orgullo pesa, pero la vida pesa más. Buen instinto.'
];

const MENSAJES_RETROCEDER = [
    'A veces, el mejor movimiento es no moverse. Hoy elegiste bien.',
    'Te alejás sin ruido. La sombra no te vio. Y eso es una victoria.',
    'No era el momento. No era el lugar. Y vos lo supiste.'
];

function getMensajeContextualExplorar(victoria, escalon, margenKey, npcNombre) {
    let pool;
    if (victoria) {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey === 'alto') pool = MENSAJES_VICTORIA.underdog_goleada;
        else if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') pool = MENSAJES_VICTORIA.underdog_poco;
        else if (escalon === 'parejo') pool = MENSAJES_VICTORIA.parejo;
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') pool = MENSAJES_VICTORIA.favorito_poco;
        else pool = MENSAJES_VICTORIA.favorito_goleada;
    } else {
        if ((escalon === 'mas_debil' || escalon === 'mucho_mas_debil') && margenKey !== 'alto') pool = MENSAJES_DERROTA.underdog_poco;
        else if (escalon === 'mas_debil' || escalon === 'mucho_mas_debil') pool = MENSAJES_DERROTA.underdog_aplastado;
        else if (escalon === 'parejo') pool = MENSAJES_DERROTA.parejo;
        else if ((escalon === 'mas_fuerte' || escalon === 'mucho_mas_fuerte') && margenKey !== 'alto') pool = MENSAJES_DERROTA.favorito_poco;
        else pool = MENSAJES_DERROTA.favorito_aplastado;
    }
    const msg = pool[Math.floor(Math.random() * pool.length)];
    return msg.replace('{npc}', npcNombre);
}

// ============================================
// SELECCIÓN DE NPCs PARA EXPLORAR
// ============================================
async function seleccionarNPCs(pcfUsuario) {
    const { data: npcs } = await supabase.from('npcs').select('*');
    if (!npcs || npcs.length === 0) return null;

    const buckets = { facil: [], medio: [], dificil: [] };

    for (const npc of npcs) {
        const pcfNpc = npc.pcf_final || npc.pcf_calculado || 0;
        if (pcfNpc <= 0) continue;
        const prob = calcularProbabilidadVictoria(pcfUsuario, pcfNpc);
        if (prob < 0.01) continue;
        const bucket = getBucket(prob);
        if (bucket) buckets[bucket].push({ npc, prob });
    }

    // Fallback en cascada: si un bucket está vacío, buscar el más cercano ±25%
    const seleccionados = {};
    for (const key of ['facil', 'medio', 'dificil']) {
        if (buckets[key].length > 0) {
            const elegido = buckets[key][Math.floor(Math.random() * buckets[key].length)];
            seleccionados[key] = elegido;
        } else {
            // Fallback: NPC más cercano
            let mejor = null;
            let mejorDiff = Infinity;
            for (const npc of npcs) {
                const pcfNpc = npc.pcf_final || npc.pcf_calculado || 0;
                if (pcfNpc <= 0) continue;
                const ratio = pcfNpc / pcfUsuario;
                const diff = Math.abs(ratio - 1);
                if (diff < mejorDiff && ratio >= 0.75 && ratio <= 1.25) {
                    mejorDiff = diff;
                    mejor = { npc, prob: calcularProbabilidadVictoria(pcfUsuario, pcfNpc) };
                }
            }
            if (mejor) seleccionados[key] = mejor;
        }
    }

    if (Object.keys(seleccionados).length < 3) return null;

    // Aplicar varianza y calcular resultado
    const opciones = {};
    for (const key of ['facil', 'medio', 'dificil']) {
        const { npc } = seleccionados[key];
        const pcfNpc = npc.pcf_final || npc.pcf_calculado || 0;
        const pcfUserFinal = aplicarVariacion(pcfUsuario);
        const pcfNpcFinal = aplicarVariacion(pcfNpc);
        const victoria = pcfUserFinal > pcfNpcFinal;
        const ganador = Math.max(pcfUserFinal, pcfNpcFinal);
        const perdedor = Math.min(pcfUserFinal, pcfNpcFinal);
        const margen = (ganador - perdedor) / perdedor;

        // Escalón basado en ratio pre-varianza
        const ratio = pcfNpc / pcfUsuario;
        let escalon;
        if (victoria) {
            // Usuario gana → el NPC era más débil o parejo
            escalon = getEscalon(1 / ratio);
        } else {
            escalon = getEscalon(ratio);
        }
        const margenKey = getMargenKey(margen);
        const recompensas = calcularRecompensasExplorar(npc, key, escalon, margenKey, victoria);
        const castigos = calcularRecompensasExplorar(npc, key, escalon, margenKey, false);

        opciones[key] = {
            npc: npc.nombre,
            nivel: npc.nivel,
            pcf_npc: pcfNpc,
            pcf_usuario: pcfUsuario,
            victoria,
            escalon,
            margen_key: margenKey,
            recompensa_conq: recompensas.conq,
            recompensa_berries: recompensas.berries,
            castigo_conq: castigos.conq,
            castigo_berries: castigos.berries
        };
    }

    return opciones;
}

// ============================================
// COOLDOWN DE EXPLORAR
// ============================================
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
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
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
// TEXTOS DE AYUDA
// ============================================
const AYUDA_MENU = `📖 AYUDA - op_d_bot — ¿Qué querés ver? 💬 !ayudachat → Comandos de chat 📩 !ayudasusurro → Comandos de susurro`;

const AYUDA_CHAT = `💬 COMANDOS DE CHAT 🎮 !op → Entrena Haki (3/día) 📊 !infoop → Tu info (corta) 🍎 !fruta → Busca fruta 😋 !comer → Consume ❌ !rechazar → Rechaza ⏳ !frutapendiente → Evento fruta pendiente ✅ !si / ❌ !no → Decide evento fruta ⚔️ !pelear / 🏃 !huir → Combate fruta`;

const AYUDA_SUSURRO = `📩 COMANDOS DE SUSURRO 🗺️ !explorar → Explora el mundo (1/día) ➡️ !continuar / ⬅️ !retroceder → Decide exploración ⚔️ !combatir / 🏃 !retirarse → Combate exploración ⏳ !exploracionpendiente → Evento exploración 📊 !infoop → Tu info (detallada) 👤 !infoop @usuario → Info corta de otro`;

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
        type: 'user.whisper.message', version: '1',
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
    } catch (err) { console.error('❌ Error de red al suscribirse:', err); }
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
    } catch (err) { console.error('❌ Error de red al enviar susurro:', err); }
}

setTimeout(startEventSubWebSocket, 3000);

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

    console.log(`📩 [SUSURRO] de ${fromUserLogin}: ${messageText}`);

    // ========== !testwhisper ==========
    if (command === '!testwhisper') {
        await sendWhisper(fromUserId, `¡Hola ${fromUserLogin}! Los susurros funcionan correctamente. 🎉`);
        return;
    }

    // ========== !ayuda / !ayudaop ==========
    if (command === '!ayuda' || command === '!ayudaop') {
        await sendWhisper(fromUserId, AYUDA_MENU); return;
    }
    if (command === '!ayudachat') { await sendWhisper(fromUserId, AYUDA_CHAT); return; }
    if (command === '!ayudasusurro') { await sendWhisper(fromUserId, AYUDA_SUSURRO); return; }

    // ========== !infoop (propio detallado) ==========
    if (command === '!infoop' && !args[1]) {
        const user = await getUsuario(username);
        const esSupremoUser = await esSupremo(username);

        let frutaTexto = '🍎 Ninguna';
        if (user?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = `🍎 ${user.fruta} ${frutaData?.emoji || ''}`.trim();
        }

        const rangoArm = getRangoArmadura(user?.armadura || 0, esSupremoUser);
        const rangoObs = getRangoArmadura(user?.observacion || 0);
        const conqPts = user?.conquistador || 0;
        let rangoConq;
        if (conqPts < 60) rangoConq = 'No despertado';
        else if (conqPts <= 79) rangoConq = 'Despertado';
        else if (conqPts <= 94) rangoConq = 'Básico';
        else if (conqPts <= 100) rangoConq = 'Avanzado';
        else rangoConq = 'Supremo';

        // Estado de exploración
        let estadoExplorar = 'disponible';
        if (user.evento_explorar_estado === 'pendiente') estadoExplorar = 'pendiente. Tirá !exploracionpendiente para retomar';
        else {
            const cd = await puedeExplorar(user);
            if (!cd.ok) estadoExplorar = `usada. Próxima en ${formatTiempoRestante(cd.restante)}`;
        }

        const mensaje = `📊 Tus estadísticas: ${frutaTexto} | 🛡️ Armadura: ${rangoArm.nombre} (${user?.armadura || 0}) ${rangoArm.emoji} | 👁️ Observación: ${rangoObs.nombre} (${user?.observacion || 0}) | ⚜️ Conquistador: ${rangoConq} (${conqPts}) | 🏴‍☠️💰 $${(user?.recompensa_publica || 0).toLocaleString('es-AR')} | 🗺️ Exploración: ${estadoExplorar}`;
        await sendWhisper(fromUserId, mensaje);
        return;
    }

    // ========== !infoop @usuario ==========
    if (command === '!infoop' && args[1]) {
        const target = args[1].replace('@', '').toLowerCase();
        const targetUser = await getUsuario(target);
        const esSupremoUser = await esSupremo(target);
        let frutaTexto = '🍎 Ninguna';
        if (targetUser?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', targetUser.fruta).single();
            frutaTexto = `🍎 ${targetUser.fruta} ${frutaData?.emoji || ''}`.trim();
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
            await sendWhisper(fromUserId, `No tienes ningún evento de fruta pendiente.`); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            await sendWhisper(fromUserId, `La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`); return;
        }
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) { await sendWhisper(fromUserId, `Error al obtener detalles del evento.`); return; }
        if (user.evento_fruta_fase === 'avistamiento') {
            await sendWhisper(fromUserId, fruta.fase1);
        } else {
            const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
            await sendWhisper(fromUserId, `${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${fruta.emoji || ''} ⚔️ ${fruta.ataque || 0} | 🛡️ ${fruta.defensa || 0} | 🧠 Utilidad: ${fruta.utilidad || 0} — ¿Qué haces? !pelear o !huir`);
        }
        return;
    }

    // ============================================
    // ========== !EXPLORAR Y SUBCOMANDOS ==========
    // ============================================

        // ========== !explorar ==========
    if (command === '!explorar') {
        const user = await getUsuario(username);

        // 1. Si tiene evento pendiente → mostrar pendiente
        if (user.evento_explorar_estado === 'pendiente') {
            if (user.evento_explorar_fase === 'menu') {
                const opciones = user.evento_explorar_opciones || {};
                const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
                await sendWhisper(fromUserId, `⏳ Ya tenés una exploración en curso. Elegí una dificultad: 🟢 !facil 💀 (+${f.recompensa_conq} Conq / +${f.recompensa_berries.toLocaleString('es-AR')} Berries) 🟡 !medio 💀💀 (+${m.recompensa_conq} Conq / +${m.recompensa_berries.toLocaleString('es-AR')} Berries) 🔴 !dificil 💀💀💀💀💀 (+${d.recompensa_conq} Conq / +${d.recompensa_berries.toLocaleString('es-AR')} Berries)`);
                return;
            }
            const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
            if (!npc) { await sendWhisper(fromUserId, `Error al obtener detalles del evento.`); return; }
            const opciones = user.evento_explorar_opciones || {};
            const op = opciones[user.evento_explorar_dificultad];
            if (user.evento_explorar_fase === 'avistamiento') {
                const castigoRetroceder = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
                await sendWhisper(fromUserId, `📍 Exploración pendiente, ${fromUserLogin}. ${npc.fase1} — Si retrocedés ahora: -${castigoRetroceder} Conquistador. Si continuás y perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. ¿Qué hacés? ➡️ !continuar o ⬅️ !retroceder`);
            } else {
                const calaveras = getCalaveras(user.evento_explorar_nivel || 1);
                const castigoRetirarse = Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
                await sendWhisper(fromUserId, `📍 Exploración pendiente, ${fromUserLogin}. ${npc.fase2} ${calaveras} — Si ganás: +${op.recompensa_conq} Conq / +${op.recompensa_berries.toLocaleString('es-AR')} Berries. Si perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. Si te retirás: -${castigoRetirarse} Conq. ⚔️ !combatir o 🏃 !retirarse`);
            }
            return;
        }

        // 2. Verificar cooldown
        const cd = await puedeExplorar(user);
        if (!cd.ok) {
            await sendWhisper(fromUserId, `⏳ Todavía no podés explorar. Próxima en ${formatTiempoRestante(cd.restante)}.`);
            return;
        }

        // 3. Calcular PCF del usuario (con poder de fruta correcto)
        let poderFrutaUsuario = 0;
        if (user.fruta) {
            const { data: frutaData } = await supabase
                .from('frutas')
                .select('poder_fruta')
                .eq('nombre', user.fruta)
                .single();
            poderFrutaUsuario = frutaData?.poder_fruta || 0;
        }

        const esSupremoUser = await esSupremo(username);
        const pcfUsuario = Math.round(calcularPoderBase(
            poderFrutaUsuario, user.armadura || 0, user.observacion || 0,
            user.conquistador || 0, esSupremoUser
        ));

        // 4. Seleccionar NPCs
        const opciones = await seleccionarNPCs(pcfUsuario);
        if (!opciones) {
            await sendWhisper(fromUserId, `🌊 El mar está tranquilo hoy. No encontrás ninguna sombra con quien pelear.`);
            return;
        }

        // 5. Guardar estado
        await updateUsuario(username, {
            evento_explorar_estado: 'pendiente',
            evento_explorar_fase: 'menu',
            evento_explorar_dificultad: null,
            evento_explorar_npc: null,
            evento_explorar_nivel: null,
            evento_explorar_pcf_usuario: pcfUsuario,
            evento_explorar_pcf_npc: null,
            evento_explorar_comandos: null,
            evento_explorar_opciones: opciones,
            ultima_exploracion: new Date().toISOString()
        });

        // 6. Mostrar menú
        const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
        const msg = `🗺️ ¡Zarpás en busca de aventura, ${fromUserLogin}! Se divisan tres caminos: 🟢 !facil 💀 → +${f.recompensa_conq} Conq / +${f.recompensa_berries.toLocaleString('es-AR')} Berries 🟡 !medio 💀💀 → +${m.recompensa_conq} Conq / +${m.recompensa_berries.toLocaleString('es-AR')} Berries 🔴 !dificil 💀💀💀💀💀 → +${d.recompensa_conq} Conq / +${d.recompensa_berries.toLocaleString('es-AR')} Berries Elegí sabiamente.`;
        await sendWhisper(fromUserId, msg);
        return;
    }

    // ========== !facil / !medio / !dificil ==========
    if (command === '!facil' || command === '!medio' || command === '!dificil') {
        const user = await getUsuario(username);
        if (user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'menu') {
            await sendWhisper(fromUserId, `No tienes una exploración pendiente de elegir.`); return;
        }
        const dificultad = command.substring(1);
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[dificultad];
        if (!op) { await sendWhisper(fromUserId, `Error: no se encontró la opción ${dificultad}.`); return; }

        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', op.npc).single();
        if (!npc) { await sendWhisper(fromUserId, `Error al obtener al NPC.`); return; }

        await updateUsuario(username, {
            evento_explorar_fase: 'avistamiento',
            evento_explorar_dificultad: dificultad,
            evento_explorar_npc: op.npc,
            evento_explorar_nivel: op.nivel,
            evento_explorar_pcf_npc: op.pcf_npc,
            evento_explorar_comandos: 'continuar_retroceder'
        });

        const castigoRetroceder = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
        const msg = `${npc.fase1} — Si retrocedés ahora: -${castigoRetroceder} Conquistador. Si continuás y perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. ¿Qué hacés? ➡️ !continuar o ⬅️ !retroceder`;
        await sendWhisper(fromUserId, msg);
        return;
    }

    // ========== !continuar ==========
    if (command === '!continuar') {
        const user = await getUsuario(username);
        if (user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, `No tienes una exploración pendiente en fase de avistamiento.`); return;
        }
        await updateUsuario(username, {
            evento_explorar_fase: 'encuentro',
            evento_explorar_comandos: 'combatir_retirarse'
        });
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        const calaveras = getCalaveras(user.evento_explorar_nivel || 1);
        const msg = `${npc.fase2} ${calaveras} — Si ganás: +${op.recompensa_conq} Conq / +${op.recompensa_berries.toLocaleString('es-AR')} Berries. Si perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. Si te retirás: -${Math.max(Math.ceil(op.castigo_conq * 0.3), 1)} Conq. ⚔️ !combatir o 🏃 !retirarse`;
        await sendWhisper(fromUserId, msg);
        return;
    }

    // ========== !retroceder ==========
    if (command === '!retroceder') {
        const user = await getUsuario(username);
        if (user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'avistamiento') {
            await sendWhisper(fromUserId, `No tienes una exploración pendiente en fase de avistamiento.`); return;
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
        const msgCtx = MENSAJES_RETROCEDER[Math.floor(Math.random() * MENSAJES_RETROCEDER.length)];
        await sendWhisper(fromUserId, `${msgCtx} ⬅️ Retrocedés, ${fromUserLogin}. -${castigo} Conquistador.`);
        return;
    }

    // ========== !combatir ==========
    if (command === '!combatir') {
        const user = await getUsuario(username);
        if (user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, `No tienes una exploración pendiente en fase de encuentro.`); return;
        }
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        if (!op) { await sendWhisper(fromUserId, `Error al obtener la opción.`); return; }

        const victoria = op.victoria;
        const msgCtx = getMensajeContextualExplorar(victoria, op.escalon, op.margen_key, op.npc);

        if (victoria) {
            await updateUsuario(username, {
                conquistador: (user.conquistador || 0) + op.recompensa_conq,
                recompensa_publica: (user.recompensa_publica || 0) + op.recompensa_berries,
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, `${msgCtx} 🏆 ¡Victoria, ${fromUserLogin}! Derrotaste a la sombra de ${op.npc}. +${op.recompensa_conq} Conquistador. +${op.recompensa_berries.toLocaleString('es-AR')} Berries.`);
        } else {
            await updateUsuario(username, {
                conquistador: Math.max((user.conquistador || 0) - op.castigo_conq, 0),
                recompensa_publica: Math.max((user.recompensa_publica || 0) - op.castigo_berries, 0),
                evento_explorar_estado: null, evento_explorar_fase: null, evento_explorar_dificultad: null,
                evento_explorar_npc: null, evento_explorar_nivel: null, evento_explorar_pcf_usuario: null,
                evento_explorar_pcf_npc: null, evento_explorar_comandos: null, evento_explorar_opciones: null
            });
            await sendWhisper(fromUserId, `${msgCtx} 💀 Derrota, ${fromUserLogin}. La sombra de ${op.npc} te superó. -${op.castigo_conq} Conquistador. -${op.castigo_berries.toLocaleString('es-AR')} Berries.`);
        }
        return;
    }

    // ========== !retirarse ==========
    if (command === '!retirarse') {
        const user = await getUsuario(username);
        if (user.evento_explorar_estado !== 'pendiente' || user.evento_explorar_fase !== 'encuentro') {
            await sendWhisper(fromUserId, `No tienes una exploración pendiente en fase de encuentro.`); return;
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
        const msgCtx = MENSAJES_RETIRARSE[Math.floor(Math.random() * MENSAJES_RETIRARSE.length)];
        await sendWhisper(fromUserId, `${msgCtx} 🏃 Te retirás, ${fromUserLogin}. -${castigo} Conquistador.`);
        return;
    }

    // ========== !exploracionpendiente ==========
    if (command === '!exploracionpendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_explorar_estado !== 'pendiente') {
            await sendWhisper(fromUserId, `No tienes ningún evento de exploración pendiente.`); return;
        }
        if (user.evento_explorar_fase === 'menu') {
            const opciones = user.evento_explorar_opciones || {};
            const f = opciones.facil, m = opciones.medio, d = opciones.dificil;
            const msg = `📍 Exploración pendiente, ${fromUserLogin}. Elegí dificultad: 🟢 !facil 💀 (+${f.recompensa_conq} Conq / +${f.recompensa_berries.toLocaleString('es-AR')} Berries) 🟡 !medio 💀💀 (+${m.recompensa_conq} / +${m.recompensa_berries.toLocaleString('es-AR')}) 🔴 !dificil 💀💀💀💀💀 (+${d.recompensa_conq} / +${d.recompensa_berries.toLocaleString('es-AR')})`;
            await sendWhisper(fromUserId, msg); return;
        }
        const { data: npc } = await supabase.from('npcs').select('*').eq('nombre', user.evento_explorar_npc).single();
        if (!npc) { await sendWhisper(fromUserId, `Error al obtener detalles del evento.`); return; }
        const opciones = user.evento_explorar_opciones || {};
        const op = opciones[user.evento_explorar_dificultad];
        if (user.evento_explorar_fase === 'avistamiento') {
            const castigoRetroceder = Math.max(Math.ceil(op.castigo_conq * 0.1), 1);
            await sendWhisper(fromUserId, `📍 Exploración pendiente, ${fromUserLogin}. ${npc.fase1} — Si retrocedés ahora: -${castigoRetroceder} Conq. Si continuás y perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. ➡️ !continuar o ⬅️ !retroceder`);
        } else {
            const calaveras = getCalaveras(user.evento_explorar_nivel || 1);
            const castigoRetirarse = Math.max(Math.ceil(op.castigo_conq * 0.3), 1);
            await sendWhisper(fromUserId, `📍 Exploración pendiente, ${fromUserLogin}. ${npc.fase2} ${calaveras} — Si ganás: +${op.recompensa_conq} Conq / +${op.recompensa_berries.toLocaleString('es-AR')} Berries. Si perdés: -${op.castigo_conq} Conq / -${op.castigo_berries.toLocaleString('es-AR')} Berries. Si te retirás: -${castigoRetirarse} Conq. ⚔️ !combatir o 🏃 !retirarse`);
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

    console.log(`💬 [CHAT #${channel}] ${username}: ${message}`);

    // ========== !ayudaop ==========
    if (command === '!ayudaop') {
        client.say(channel, `@${tags.username} 📩 Mandame un susurro con !ayudaop para ver los comandos.`);
        return;
    }

    // ========== BLOQUEO SI EXPLORACIÓN PENDIENTE ==========
    // (aplica a !op, !fruta, !comer)
    const comandosBloqueados = ['!op', '!fruta', '!comer'];
    if (comandosBloqueados.includes(command)) {
        const u = await getUsuario(username);
        if (u?.evento_explorar_estado === 'pendiente') {
            if (command === '!op') client.say(channel, `@${tags.username} No es momento de entrenar. Es momento de pelear. Terminá tu exploración primero.`);
            else if (command === '!fruta') client.say(channel, `@${tags.username} No es momento de buscar frutas. Hay una sombra esperando tu decisión.`);
            else client.say(channel, `@${tags.username} No es momento de comer. Concentrate en la pelea que tenés pendiente.`);
            return;
        }
    }

    // ========== !infoop (chat) ==========
    if (command === '!infoop') {
        if (args[1]) {
            client.say(channel, `@${tags.username} Por susurro, máquina 📩`);
            return;
        }
        const user = await getUsuario(username);
        const esSupremoUser = await esSupremo(username);
        const nuevaRecompensa = calcularRecompensa(user);
        await updateUsuario(username, { recompensa_publica: nuevaRecompensa });
        let frutaTexto = '🍎 Ninguna';
        if (user?.fruta) {
            const { data: frutaData } = await supabase.from('frutas').select('emoji').eq('nombre', user.fruta).single();
            frutaTexto = `🍎 ${user.fruta} ${frutaData?.emoji || ''}`.trim();
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
                if (delta !== 0) client.say(channel, `💤 Descuidaste tu entrenamiento. Perdiste ${Math.abs(delta)} de Haki de Armadura. ${getRangoArmadura(arm).emoji}`);
                await updateUsuario(username, { armadura: arm, op_usos_hoy: 0, ultimo_op_fecha: hoy, racha_ops: 0 });
            } else {
                await updateUsuario(username, { op_usos_hoy: 0, ultimo_op_fecha: hoy });
            }
        }
        const userAct = await getUsuario(username);
        if ((userAct.op_usos_hoy || 0) >= 3) {
            client.say(channel, `Tu cuerpo llegó al límite por hoy. Descansá y mañana seguís.`); return;
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
            if (user?.fruta) { client.say(channel, `@${tags.username} Ya tienes una fruta (${user.fruta}).`); return; }
            if (user?.evento_fruta_estado === 'pendiente') {
                client.say(channel, `@${tags.username} Ya tienes un evento de fruta pendiente. Usa !frutapendiente para ver la decisión que debes tomar.`); return;
            }
            const ahora = Date.now();
            const ultimoUso = cooldowns[`fruta_${username}`] || 0;
            const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
            if (tiempoRestante > 0) {
                const seg = Math.ceil(tiempoRestante / 1000);
                client.say(channel, `@${tags.username} Debes esperar ${seg} segundos para usar !fruta nuevamente.`); return;
            }
            cooldowns[`fruta_${username}`] = Date.now();
            if (Math.random() * 100 > PROB_FRUTA) {
                client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`); return;
            }
            const { data: usuariosConFruta } = await supabase.from('usuarios').select('fruta').not('fruta', 'is', null);
            const frutasOcupadas = (usuariosConFruta || []).map(u => u.fruta).filter(Boolean);
            let query = supabase.from('frutas').select('*');
            if (frutasOcupadas.length > 0) query = query.not('nombre', 'in', `(${frutasOcupadas.map(f => `'${f}'`).join(',')})`);
            const { data: frutasDisponibles, error: errFrutas } = await query;
            if (errFrutas || !frutasDisponibles?.length) {
                client.say(channel, `@${tags.username} No hay frutas disponibles en este momento. ¡Vuelve más tarde!`); return;
            }
            const totalProb = frutasDisponibles.reduce((s, f) => s + (Number(f.probabilidad) || 0), 0);
            let selectedFruit = null;
            if (totalProb <= 0) selectedFruit = frutasDisponibles[Math.floor(Math.random() * frutasDisponibles.length)];
            else {
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
                client.say(channel, `@${tags.username} ¡Felicidades! Has encontrado la ${selectedFruit.nombre} ${selectedFruit.emoji || ''} — ${selectedFruit.descripcion} ⚔️ ${selectedFruit.ataque || 0} | 🛡️ ${selectedFruit.defensa || 0} | 🧠 Utilidad: ${selectedFruit.utilidad || 0} — ¿Qué decisión tomas? !comer o !rechazar`);
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
            client.say(channel, `@${tags.username} No tienes ningún evento de fruta pendiente.`); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`); return;
        }
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        if (!fruta) { client.say(channel, `@${tags.username} Error al obtener detalles del evento.`); return; }
        if (user.evento_fruta_fase === 'avistamiento') {
            client.say(channel, `@${tags.username} ${fruta.fase1}`);
        } else {
            const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
            client.say(channel, `@${tags.username} ${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${fruta.emoji || ''} ⚔️ ${fruta.ataque || 0} | 🛡️ ${fruta.defensa || 0} | 🧠 Utilidad: ${fruta.utilidad || 0} — ¿Qué haces? !pelear o !huir`);
        }
        return;
    }

    // ========== !si ==========
    if (command === '!si') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`); return;
        }
        await updateUsuario(username, { evento_fruta_fase: 'encuentro', evento_fruta_comandos: 'pelear_huir' });
        const { data: fruta } = await supabase.from('frutas').select('*').eq('nombre', user.evento_fruta_nombre).single();
        const calaveras = getCalaveras(user.evento_fruta_nivel || 1);
        client.say(channel, `@${tags.username} ${fruta.fase2} ${calaveras} 🍎 ${fruta.nombre} ${fruta.emoji || ''} ⚔️ ${fruta.ataque || 0} | 🛡️ ${fruta.defensa || 0} | 🧠 Utilidad: ${fruta.utilidad || 0} — ¿Qué haces? !pelear o !huir`);
        return;
    }

    // ========== !no ==========
    if (command === '!no') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`); return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, `@${tags.username} Decides retirarte. El evento ha terminado.`); return;
    }

    // ========== !pelear ==========
    if (command === '!pelear') {
        const user = await getUsuario(username);
        if (!user || user.evento_fruta_estado !== 'pendiente' || user.evento_fruta_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`); return;
        }
        if (user.evento_fruta_comida_por_otro) {
            await updateUsuario(username, {
                evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                evento_fruta_comida_por_otro: false
            });
            client.say(channel, `@${tags.username} La fruta que tenías pendiente ya fue consumida por otro usuario. Tu evento ha sido cancelado.`); return;
        }
        const { data: frutaData } = await supabase.from('frutas')
            .select('poder_fruta, sombra, emoji').eq('nombre', user.evento_fruta_nombre).single();
        const poderFrutaUsuario = frutaData?.poder_fruta || 0;
        const nombreSombra = frutaData?.sombra || null;
        const emojiFruta = frutaData?.emoji || '';
        const esSupremoUser = await esSupremo(username);
        const poderUsuario = calcularPoderBase(poderFrutaUsuario, user.armadura || 0, user.observacion || 0, user.conquistador || 0, esSupremoUser);
        let poderEnemigoBase = 80;
        if (nombreSombra) {
            const { data: npc } = await supabase.from('npcs').select('pcf_final, pcf_calculado, nivel').eq('nombre', nombreSombra).maybeSingle();
            poderEnemigoBase = npc?.pcf_final || npc?.pcf_calculado || 80;
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
                    recompensa_publica: (user.recompensa_publica || 0) + recBerries,
                    evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
                    evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
                    evento_fruta_comida_por_otro: false
                });
                client.say(channel, `@${tags.username} ${mensaje} Pero la ${user.evento_fruta_nombre} ya fue consumida por otro usuario. No puedes obtenerla.`); return;
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
            const { data: afectados } = await supabase.from('usuarios').select('username')
                .eq('evento_fruta_nombre', user.evento_fruta_nombre)
                .eq('evento_fruta_estado', 'pendiente').neq('username', username);
            if (afectados?.length > 0) {
                for (const a of afectados) await updateUsuario(a.username, { evento_fruta_comida_por_otro: true });
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
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`); return;
        }
        await updateUsuario(username, {
            evento_fruta_tipo: null, evento_fruta_fase: null, evento_fruta_nombre: null,
            evento_fruta_nivel: null, evento_fruta_estado: null, evento_fruta_comandos: null,
            evento_fruta_comida_por_otro: false
        });
        client.say(channel, `@${tags.username} Has decidido huir. No has obtenido la fruta.`); return;
    }

    // ========== !comer ==========
    if (command === '!comer') {
        const user = await getUsuario(username);
        if (user?.fruta_pendiente) {
            const { data: frutaData } = await supabase.from('frutas').select('descripcion, emoji').eq('nombre', user.fruta_pendiente).single();
            await updateUsuario(username, { fruta: user.fruta_pendiente, fruta_pendiente: null });
            client.say(channel, `@${tags.username} Has consumido la ${user.fruta_pendiente} ${frutaData?.emoji || ''}. Ahora eres un ${frutaData?.descripcion || ''}.`);
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
        client.say(channel, `@${tags.username} Has ${signo > 0 ? 'sumado' : 'restado'} ${cantidad} de ${nombre} a @${target}. Ahora tiene ${nuevo}.`);
        return;
    }
    if (command === '!quitarfruta') {
        if (args.length < 2) return client.say(channel, `@${tags.username} Uso: !quitarfruta @usuario`);
        const target = args[1].replace('@', '').toLowerCase();
        await updateUsuario(target, { fruta: null, fruta_pendiente: null });
        client.say(channel, `@${tags.username} Has quitado la fruta a @${target}.`); return;
    }
    if (command === '!setpcf') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !setpcf nombreNPC poder`);
        const npcNombre = args[1].toLowerCase();
        const nuevoPoder = parseInt(args[2]);
        if (isNaN(nuevoPoder) || nuevoPoder < 0) return client.say(channel, `@${tags.username} El poder debe ser un número positivo.`);
        const { data: npcExistente } = await supabase.from('npcs').select('*').eq('nombre', npcNombre).maybeSingle();
        if (npcExistente) {
            await supabase.from('npcs').update({ pcf_final: nuevoPoder }).eq('nombre', npcNombre);
        } else {
            await supabase.from('npcs').insert([{ nombre: npcNombre, pcf_final: nuevoPoder, nivel: 4 }]);
        }
        client.say(channel, `@${tags.username} Has cambiado el PCF de ${npcNombre} a ${nuevoPoder}.`); return;
    }
});

console.log('Bot escuchando...');