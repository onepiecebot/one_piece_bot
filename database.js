const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://pditdbvzyqjvalkznpcv.supabase.co';
const supabaseKey = 'sb_publishable_4-NeJ86heLfWJzvX3_GPYA_9KLSvLPG';

const supabase = createClient(supabaseUrl, supabaseKey);

(async () => {
    const { error } = await supabase.from('usuarios').select('count').limit(0);
    if (error) console.error('❌ Error de conexión a Supabase:', error.message);
    else console.log('✅ Conexión a Supabase establecida correctamente.');
})();

// ==================== FECHAS ====================
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

function getFechaNpc() {
    const ahora = new Date();
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    if (arg.getHours() < 3) arg.setDate(arg.getDate() - 1);
    return arg.toISOString().split('T')[0];
}

// ==================== USUARIOS ====================
async function getUsuario(username) {
    const { data, error } = await supabase.from('usuarios').select('*').eq('username', username);
    if (error) { console.error('❌ Error getUsuario:', error); return null; }
    if (!data || data.length === 0) {
        const { data: newUser, error: insertError } = await supabase
            .from('usuarios')
            .insert([{
                username, armadura: 0, observacion: 0, conquistador: 0,
                fruta: null, fruta_pendiente: null,
                recompensa_publica: 0, recompensa_delta: 0,
                racha_dia: 0, ultimo_comando: 0, minutos_lurk: 0,
                rechazo_usado: 0, ultimo_dia: null, titulos: [],
                op_usos_hoy: 0, ultimo_op_fecha: null, ultimo_op_timestamp: null,
                racha_ops: 0, ultimo_dia_racha: null,
                supremos_min_historico: 0
            }])
            .select().single();
        if (insertError) { console.error('❌ Error creando usuario:', insertError); return null; }
        await supabase.from('lurk_stats').insert([{ username }]);
        return newUser;
    }
    return data[0];
}

async function updateUsuario(username, datos) {
    const { data, error } = await supabase
        .from('usuarios').update(datos).eq('username', username).select();
    if (error) { console.error('❌ Error updateUsuario:', error); return null; }
    return data;
}
// Solo verifica si el usuario existe, sin crear nada
async function usuarioExiste(username) {
    const { data, error } = await supabase
        .from('usuarios').select('username').eq('username', username).limit(1);
    if (error) return false;
    return !!(data && data.length > 0);
}

// ==================== TEXTOS ====================
async function getTextoDuelo(situacion) {
    const { data, error } = await supabase
        .from('textos_eventos').select('texto')
        .eq('grupo', 'duelo').eq('situacion', situacion);
    if (error || !data || data.length === 0) {
        console.error('❌ Error getTextoDuelo:', error && error.message);
        return '⚔️ Duelo resuelto.';
    }
    return data[Math.floor(Math.random() * data.length)].texto;
}

async function getTextoExplorar(situacion) {
    const { data, error } = await supabase
        .from('textos_eventos').select('texto')
        .eq('grupo', 'explorar').eq('situacion', situacion);
    if (error || !data || data.length === 0) {
        console.error('❌ Error getTextoExplorar:', error && error.message);
        return 'El combate ha terminado.';
    }
    return data[Math.floor(Math.random() * data.length)].texto;
}

// ==================== DUELOS ====================
async function getHistorialH2H(userA, userB) {
    const { data, error } = await supabase
        .from('duelos').select('retador, retado, ganador, estado, monto')
        .or(`and(retador.eq.${userA},retado.eq.${userB}),and(retador.eq.${userB},retado.eq.${userA})`);
    if (error || !data) return { total: 0, ganadosA: 0, empates: 0, ganadosB: 0, neto: 0 };
    let ganadosA = 0, ganadosB = 0, empates = 0, neto = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (d.estado === 'empate') empates++;
        else if (d.ganador === userA) { ganadosA++; neto += (d.monto || 0); }
        else if (d.ganador === userB) { ganadosB++; neto -= (d.monto || 0); }
    }
    return { total: data.length, ganadosA, empates, ganadosB, neto };
}

async function contarDuelosHoy(username) {
    const hoyInicio = getFechaHoy() + 'T00:00:00-03:00';
    const { count, error } = await supabase.from('duelos')
        .select('*', { count: 'exact', head: true })
        .or(`retador.eq.${username},retado.eq.${username}`).gte('fecha', hoyInicio);
    if (error) return 0;
    return count || 0;
}

async function contarDuelosHoyEntre(a, b) {
    const hoyInicio = getFechaHoy() + 'T00:00:00-03:00';
    const { count, error } = await supabase.from('duelos')
        .select('*', { count: 'exact', head: true })
        .or(`and(retador.eq.${a},retado.eq.${b}),and(retador.eq.${b},retado.eq.${a})`).gte('fecha', hoyInicio);
    if (error) return 0;
    return count || 0;
}

async function fueRechazadoHoy(retador, retado) {
    const hoyInicio = getFechaHoy() + 'T00:00:00-03:00';
    const { count, error } = await supabase.from('duelos')
        .select('*', { count: 'exact', head: true })
        .eq('retador', retador).eq('retado', retado).eq('estado', 'rechazado').gte('fecha', hoyInicio);
    if (error) return false;
    return (count || 0) > 0;
}

async function crearDuelo(data) {
    const { data: result, error } = await supabase.from('duelos').insert([data]).select().single();
    if (error) { console.error('❌ Error crearDuelo:', error.message); return null; }
    return result;
}

async function limpiarEventoDuelo(username) {
    return await updateUsuario(username, {
        evento_duelo_estado: null, evento_duelo_retador: null, evento_duelo_retado: null,
        evento_duelo_pcf_retador: null, evento_duelo_expira: null, evento_duelo_canal: null
    });
}

async function tieneEventoPendiente(username) {
    const user = await getUsuario(username);
    if (!user) return false;
    return (user.evento_duelo_estado === 'pendiente' || user.evento_explorar_estado === 'pendiente' || user.evento_fruta_estado === 'pendiente');
}

async function completoExplorarHoy(username) {
    const user = await getUsuario(username);
    if (!user) return false;
    return (user.ultimo_dia_exploracion === getFechaHoy() && user.evento_explorar_estado !== 'pendiente');
}

// ==================== LURK ====================
async function getLurkStats(username) {
    const { data, error } = await supabase.from('lurk_stats').select('*').eq('username', username).maybeSingle();
    if (error) { console.error('❌ Error getLurkStats:', error.message); return null; }
    if (!data) {
        const { data: created, error: insErr } = await supabase
            .from('lurk_stats').insert([{ username }]).select().single();
        if (insErr) { console.error('❌ Error creando lurk_stats:', insErr.message); return null; }
        return created;
    }
    return data;
}

async function updateLurkStats(username, datos) {
    const { data, error } = await supabase.from('lurk_stats').update(datos).eq('username', username).select();
    if (error) { console.error('❌ Error updateLurkStats:', error.message); return null; }
    return data;
}

async function getHistorialLurk(username, dias) {
    if (dias === undefined) dias = 20;
    const limite = getFechaOffset(-dias);
    const { data, error } = await supabase.from('lurk_historial')
        .select('fecha, puntos, minutos').eq('username', username)
        .gte('fecha', limite).order('fecha', { ascending: false });
    if (error) { console.error('❌ Error getHistorialLurk:', error.message); return []; }
    return data || [];
}

// Agrega puntos al historial del día + recalcula observacion
async function agregarPuntosObservacion(username, puntos, minutos) {
    if (minutos === undefined) minutos = 0;
    const hoy = getFechaHoy();
    const { data: existing } = await supabase.from('lurk_historial')
        .select('id, puntos, minutos').eq('username', username).eq('fecha', hoy).maybeSingle();
    if (existing) {
        await supabase.from('lurk_historial')
            .update({ puntos: (existing.puntos || 0) + puntos, minutos: (existing.minutos || 0) + minutos })
            .eq('id', existing.id);
    } else {
        await supabase.from('lurk_historial').insert([{ username, fecha: hoy, puntos, minutos }]);
    }
    await recalcularObservacion(username);
}

// Recalcula usuarios.observacion = suma de últimos 20 días de historial
async function recalcularObservacion(username) {
    const limite = getFechaOffset(-19); // últimos 20 días incluyendo hoy
    const { data, error } = await supabase.from('lurk_historial')
        .select('puntos').eq('username', username).gte('fecha', limite);
    if (error) { console.error('❌ Error recalcularObservacion:', error.message); return null; }
    const total = (data || []).reduce((s, r) => s + (r.puntos || 0), 0);
    const nuevo = Math.max(0, total);
    await updateUsuario(username, { observacion: nuevo });
    return nuevo;
}

async function limpiarHistorialViejo() {
    const limite = getFechaOffset(-20);
    const { error } = await supabase.from('lurk_historial').delete().lt('fecha', limite);
    if (error) console.error('❌ Error limpiando historial:', error.message);
}

// Aplica penalización acumulada por días inactivos con stream
// Recorre desde el día siguiente a lurk_ultimo_dia hasta ayer (inclusive)
async function aplicarPenalizacionesInactivas(username, lurkStats) {
    const ultimoDia = lurkStats.lurk_ultimo_dia;
    if (!ultimoDia) return 0;
    const ayer = getFechaOffset(-1);
    const fechaUltimo = new Date(ultimoDia + 'T00:00:00');
    const fechaAyer = new Date(ayer + 'T00:00:00');
    // Días entre ultimoDia (exclusive) y ayer (inclusive)
    const dias = Math.max(0, Math.floor((fechaAyer - fechaUltimo) / (1000 * 60 * 60 * 24)));
    if (dias <= 0) return 0;
    let totalPenalizacion = 0;
    for (let i = 1; i <= dias; i++) {
        const fechaCheck = getFechaOffset(-i);
        const hubo = await huboStreamEseDia(fechaCheck);
        if (hubo) {
            // Insertar -5 en historial de ese día (si no existe ya)
            const { data: existing } = await supabase.from('lurk_historial')
                .select('id').eq('username', username).eq('fecha', fechaCheck).maybeSingle();
            if (!existing) {
                await supabase.from('lurk_historial').insert([{ username, fecha: fechaCheck, puntos: -5, minutos: 0 }]);
                totalPenalizacion += 5;
            }
        }
    }
    if (totalPenalizacion > 0) {
        await recalcularObservacion(username);
    }
    return totalPenalizacion;
}

// ==================== CANALES ====================
async function getCanal(canal) {
    const { data, error } = await supabase.from('canales').select('*').eq('canal', canal).maybeSingle();
    if (error) { console.error('❌ Error getCanal:', error.message); return null; }
    return data;
}

async function getCanales() {
    const { data, error } = await supabase.from('canales').select('*');
    if (error) { console.error('❌ Error getCanales:', error.message); return []; }
    return data || [];
}

async function updateCanal(canal, datos) {
    const { data, error } = await supabase.from('canales').update(datos).eq('canal', canal).select();
    if (error) { console.error('❌ Error updateCanal:', error.message); return null; }
    return data;
}

// ¿Hubo stream (2h+) ese día en algún canal?
async function huboStreamEseDia(fecha) {
    const { data, error } = await supabase.from('canales')
        .select('canal').eq('dia_contado_2h', fecha).limit(1);
    if (error) return false;
    return data && data.length > 0;
}

// ==================== INICIALIZACIÓN DE DÍA ====================
// Se llama al primer comando del día de un usuario.
// Si cambió el día: aplica penalizaciones, resetea contadores diarios.
async function inicializarDiaLurk(username) {
    const lurk = await getLurkStats(username);
    if (!lurk) return null;
    const hoy = getFechaHoy();
    if (lurk.lurk_ultimo_dia === hoy) {
        return { penalizacion: 0, reseteado: false, lurk };
    }
    // Aplicar penalizaciones de días inactivos con stream
    const penalizacion = await aplicarPenalizacionesInactivas(username, lurk);
    // Resetear contadores diarios
    await updateLurkStats(username, {
        lurk_minutos_hoy: 0,
        lurk_puntos_hoy: 0,
        lurk_postas_hoy: 0,
        lurk_npc_pendiente: 0,
        lurk_npc_canjeado_hoy: false,
        lurk_rango_inicio: null,
        lurk_ultimo_dia: hoy,
        lurk_join_actual: null,
        lurk_ultimo_chequeo: new Date().toISOString()
    });
    return { penalizacion, reseteado: true, lurk: await getLurkStats(username) };
}

module.exports = {
    getUsuario, updateUsuario, supabase,
    getTextoDuelo, getTextoExplorar, getHistorialH2H,
    contarDuelosHoy, contarDuelosHoyEntre, fueRechazadoHoy,
    crearDuelo, limpiarEventoDuelo, tieneEventoPendiente,
    completoExplorarHoy, getFechaHoy, getFechaOffset, getFechaNpc,
    usuarioExiste,
    // Lurk
    getLurkStats, updateLurkStats,
    getHistorialLurk, agregarPuntosObservacion, recalcularObservacion,
    limpiarHistorialViejo, aplicarPenalizacionesInactivas,
    getCanal, getCanales, updateCanal, huboStreamEseDia,
    inicializarDiaLurk
};