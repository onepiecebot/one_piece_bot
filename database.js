const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

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
    const utcMs = ahora.getTime() + (diasOffset * 24 * 60 * 60 * 1000);
    const arMs = utcMs - (3 * 60 * 60 * 1000);
    const arDate = new Date(arMs);
    const y = arDate.getUTCFullYear();
    const m = String(arDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(arDate.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}
const getFechaHoy = () => getFechaOffset(0);

function getFechaNpc() {
    const ahora = new Date();
    const utcMs = ahora.getTime();
    const arMs = utcMs - (3 * 60 * 60 * 1000);
    const arDate = new Date(arMs);
    if (arDate.getUTCHours() < 3) {
        arDate.setUTCDate(arDate.getUTCDate() - 1);
    }
    return arDate.toISOString().split('T')[0];
}

// ==================== USUARIOS ====================
async function getUsuario(username, crearSiNoExiste = true) {
    const { data, error } = await supabase.from('usuarios').select('*').eq('username', username);
    if (error) { console.error('❌ Error getUsuario:', error); return null; }
    if (!data || data.length === 0) {
        if (!crearSiNoExiste) return null; // No crear usuarios nuevos en operaciones sobre otros
        const { data: newUser, error: insertError } = await supabase
            .from('usuarios')
            .insert([{
                username, armadura: 0, observacion: 0, conquistador: 5,
                fruta: null, fruta_pendiente: null,
                recompensa_publica: 0, recompensa_delta: 0,
                minutos_lurk: 0,
                op_usos_hoy: 0, ultimo_op_fecha: null, ultimo_op_timestamp: null,
                racha_ops: 0, ultimo_dia_racha: null
            }])
            .select().single();
        if (insertError) { console.error('❌ Error creando usuario:', insertError); return null; }
        await supabase.from('lurkv2').insert([{ usuario: username }]);
        await supabase.from('lurkreg').insert([{ usuario: username }]);
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
        .or(`and(retador.eq.${userA},retado.eq.${userB}),and(retador.eq.${userB},retado.eq.${userA})`)
        .in('estado', ['finalizado', 'empate']);
    if (error || !data) return { total: 0, ganadosA: 0, empates: 0, ganadosB: 0, neto: 0 };
    let ganadosA = 0, ganadosB = 0, empates = 0, neto = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (d.estado === 'empate') empates++;
        else if (d.ganador === userA) { ganadosA++; neto += (d.monto || 0); }
        else if (d.ganador === userB) { ganadosB++; neto -= (d.monto || 0); }
    }
    return { total: ganadosA + ganadosB + empates, ganadosA, empates, ganadosB, neto };
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

// ==================== CANALES ====================
async function getCanalesActivos() {
    const { data } = await supabase.from('canales').select('*').eq('bot_activo', true);
    return data || [];
}
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

// ==================== LURKV2 (estado diario) ====================
async function getLurkV2(username) {
    const { data, error } = await supabase
        .from('lurkv2').select('*').eq('usuario', username).limit(1);
    if (error) { console.error('❌ Error getLurkV2:', error.message); return null; }
    if (!data || data.length === 0) {
        // Verificar que el usuario exista antes de crear
        const { data: user } = await supabase
            .from('usuarios').select('username').eq('username', username).limit(1);
        if (!user || user.length === 0) return null;
        const { data: created, error: insErr } = await supabase
            .from('lurkv2').insert([{ usuario: username }]).select().limit(1);
        if (insErr) { console.error('❌ Error creando lurkv2:', insErr.message); return null; }
        return created && created[0];
    }
    return data[0];
}

async function updateLurkV2(username, datos) {
    const { data, error } = await supabase
        .from('lurkv2').update(datos).eq('usuario', username).select();
    if (error) { console.error('❌ Error updateLurkV2:', error.message); return null; }
    return data;
}

// ==================== LURKREG (acumulado) ====================
async function getLurkReg(username) {
    const { data, error } = await supabase
        .from('lurkreg').select('*').eq('usuario', username).limit(1);
    if (error) { console.error('❌ Error getLurkReg:', error.message); return null; }
    if (!data || data.length === 0) {
        const { data: user } = await supabase
            .from('usuarios').select('username').eq('username', username).limit(1);
        if (!user || user.length === 0) return null;
        const { data: created, error: insErr } = await supabase
            .from('lurkreg').insert([{ usuario: username }]).select().limit(1);
        if (insErr) { console.error('❌ Error creando lurkreg:', insErr.message); return null; }
        return created && created[0];
    }
    return data[0];
}

async function updateLurkReg(username, datos) {
    const { data, error } = await supabase
        .from('lurkreg').update(datos).eq('usuario', username).select();
    if (error) { console.error('❌ Error updateLurkReg:', error.message); return null; }
    return data;
}

// ==================== LURKREG (negocio) ====================

// Suma los 20 slots contados (todos menos el de vigencia)
async function recalcularObservacionNueva(username) {
    const reg = await getLurkReg(username);
    if (!reg) return null;
    const v = reg.vigencia || 0;
    
    let total21 = 0;
    for (let i = 1; i <= 21; i++) total21 += reg['dia' + i] || 0;
    
    let total;
    if (v <= 20) {
        total = total21;
    } else {
        const slotActual = ((v - 1) % 21) + 1;
        const slotNext = (slotActual % 21) + 1;
        const vActual = reg['dia' + slotActual] || 0;
        const vNext = reg['dia' + slotNext] || 0;
        total = total21 - Math.min(vActual, vNext);
    }
    total = Math.max(0, total);
    await updateLurkReg(username, { puntos_actuales: total });
    await updateUsuario(username, { observacion: total });
    return total;
}

// Agrega puntos al slot de vigencia actual + lurkv2.puntos_hoy
async function agregarPuntosObservacionNueva(username, puntos) {
    if (!puntos || puntos === 0) return null;
    let reg = await getLurkReg(username);
    if (!reg) return null;
    if (!reg.vigencia || reg.vigencia === 0) {
        // Primera vez que acumula puntos: arrancamos la ventana en vigencia 1
        await updateLurkReg(username, { vigencia: 1 });
        reg = await getLurkReg(username);
        if (!reg) return null;
    }
    const slotActual = 'dia' + (((reg.vigencia - 1) % 21) + 1);
    const valorActual = reg[slotActual] || 0;
    await updateLurkReg(username, { [slotActual]: valorActual + puntos });
    const v2 = await getLurkV2(username);
    if (v2) {
        await updateLurkV2(username, { puntos_hoy: (v2.puntos_hoy || 0) + puntos });
    }
    return await recalcularObservacionNueva(username);
}

// Avanza la vigencia (ring buffer)
async function avanzarVigencia(username) {
    const reg = await getLurkReg(username);
    if (!reg) return null;
    const nueva = (reg.vigencia || 0) + 1;
    const slotNuevo = 'dia' + (((nueva - 1) % 21) + 1);
    await updateLurkReg(username, {
        vigencia: nueva,
        [slotNuevo]: 0
    });
    return await recalcularObservacionNueva(username);
}

// Lee cuántos puntos tiene el usuario en el día en curso
async function getPuntosDiaActual(username) {
    const reg = await getLurkReg(username);
    if (!reg || !reg.vigencia || reg.vigencia === 0) return 0;
    return reg['dia' + reg.vigencia] || 0;
}

module.exports = {
    getUsuario, updateUsuario, supabase,
    getTextoDuelo, getTextoExplorar, getHistorialH2H,
    contarDuelosHoy, contarDuelosHoyEntre, fueRechazadoHoy,
    crearDuelo, limpiarEventoDuelo, tieneEventoPendiente,
    completoExplorarHoy, getFechaHoy, getFechaOffset, getFechaNpc,
    usuarioExiste,
    getCanal, getCanales, updateCanal, huboStreamEseDia,
    getCanalesActivos,
    // Lurk nuevo
    getLurkV2, updateLurkV2,
    getLurkReg, updateLurkReg,
    recalcularObservacionNueva, agregarPuntosObservacionNueva,
    avanzarVigencia, getPuntosDiaActual
};