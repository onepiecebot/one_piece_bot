const { createClient } = require('@supabase/supabase-js');

// ⚠️ Verificá que estas 2 líneas tengan TUS datos reales de Supabase
const supabaseUrl = 'https://pditdbvzyqjvalkznpcv.supabase.co';
const supabaseKey = 'sb_publishable_4-NeJ86heLfWJzvX3_GPYA_9KLSvLPG';

const supabase = createClient(supabaseUrl, supabaseKey);

(async () => {
    const { data, error } = await supabase.from('usuarios').select('count').limit(0);
    if (error) {
        console.error('❌ Error de conexión a Supabase:', error.message);
    } else {
        console.log('✅ Conexión a Supabase establecida correctamente.');
    }
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

// ==================== FUNCIONES BÁSICAS ====================
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

// ==================== HELPERS DE DUELOS ====================
async function getHistorialH2H(userA, userB) {
    const { data, error } = await supabase
        .from('duelos')
        .select('retador, retado, ganador, estado, monto')
        .or(`and(retador.eq.${userA},retado.eq.${userB}),and(retador.eq.${userB},retado.eq.${userA})`);
    if (error || !data) {
        console.error('❌ Error getHistorialH2H:', error && error.message);
        return { total: 0, ganadosA: 0, empates: 0, ganadosB: 0, neto: 0 };
    }
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
    const { count, error } = await supabase
        .from('duelos').select('*', { count: 'exact', head: true })
        .or(`retador.eq.${username},retado.eq.${username}`)
        .gte('fecha', hoyInicio);
    if (error) { console.error('❌ Error contarDuelosHoy:', error.message); return 0; }
    return count || 0;
}

async function contarDuelosHoyEntre(a, b) {
    const hoyInicio = getFechaHoy() + 'T00:00:00-03:00';
    const { count, error } = await supabase
        .from('duelos').select('*', { count: 'exact', head: true })
        .or(`and(retador.eq.${a},retado.eq.${b}),and(retador.eq.${b},retado.eq.${a})`)
        .gte('fecha', hoyInicio);
    if (error) { console.error('❌ Error contarDuelosHoyEntre:', error.message); return 0; }
    return count || 0;
}

async function fueRechazadoHoy(retador, retado) {
    const hoyInicio = getFechaHoy() + 'T00:00:00-03:00';
    const { count, error } = await supabase
        .from('duelos').select('*', { count: 'exact', head: true })
        .eq('retador', retador).eq('retado', retado).eq('estado', 'rechazado')
        .gte('fecha', hoyInicio);
    if (error) { console.error('❌ Error fueRechazadoHoy:', error.message); return false; }
    return (count || 0) > 0;
}

async function crearDuelo(data) {
    const { data: result, error } = await supabase
        .from('duelos').insert([data]).select().single();
    if (error) { console.error('❌ Error crearDuelo:', error.message); return null; }
    return result;
}

async function limpiarEventoDuelo(username) {
    return await updateUsuario(username, {
        evento_duelo_estado: null,
        evento_duelo_retador: null,
        evento_duelo_retado: null,
        evento_duelo_pcf_retador: null,
        evento_duelo_expira: null,
        evento_duelo_canal: null
    });
}

async function tieneEventoPendiente(username) {
    const user = await getUsuario(username);
    if (!user) return false;
    return (
        user.evento_duelo_estado === 'pendiente' ||
        user.evento_explorar_estado === 'pendiente' ||
        user.evento_fruta_estado === 'pendiente'
    );
}

async function completoExplorarHoy(username) {
    const user = await getUsuario(username);
    if (!user) return false;
    const hoy = getFechaHoy();
    return (
        user.ultimo_dia_exploracion === hoy &&
        user.evento_explorar_estado !== 'pendiente'
    );
}

module.exports = {
    getUsuario,
    updateUsuario,
    supabase,
    getTextoDuelo,
    getTextoExplorar,
    getHistorialH2H,
    contarDuelosHoy,
    contarDuelosHoyEntre,
    fueRechazadoHoy,
    crearDuelo,
    limpiarEventoDuelo,
    tieneEventoPendiente,
    completoExplorarHoy,
    getFechaHoy
};