const { createClient } = require('@supabase/supabase-js');

// ============================================================
// ⚠️ REEMPLAZÁ ESTAS DOS LÍNEAS CON TUS DATOS DE SUPABASE
// ============================================================
const supabaseUrl = 'https://pditdbvzyqjvalkznpcv.supabase.co';  // <- TU URL
const supabaseKey = 'sb_publishable_4-NeJ86heLfWJzvX3_GPYA_9KLSvLPG';  // <- TU ANON KEY (la pública)
// ============================================================

const supabase = createClient(supabaseUrl, supabaseKey);

// Verificación de conexión al iniciar
(async () => {
    const { data, error } = await supabase.from('usuarios').select('count').limit(0);
    if (error) {
        console.error('❌ Error de conexión a Supabase:', error.message);
        console.error('   Verificá que la URL y la Anon Key sean correctas.');
    } else {
        console.log('✅ Conexión a Supabase establecida correctamente.');
    }
})();

// ==================== FUNCIONES ====================

async function getUsuario(username) {
    console.log(`🔍 getUsuario llamado para: "${username}"`);

    // Obtener usuario
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('username', username);

    if (error) {
        console.error('❌ Error al obtener usuario:', error);
        return null;
    }

    // Si no existe, crearlo
    if (!data || data.length === 0) {
        console.log(`📝 Usuario "${username}" no existe. Creando...`);

        const { data: newUser, error: insertError } = await supabase
            .from('usuarios')
            .insert([{
                username,
                armadura: 0,
                observacion: 0,
                conquistador: 0,
                fruta: null,
                fruta_pendiente: null,
                recompensa_publica: 0,
                racha_dia: 0,
                ultimo_comando: 0,
                minutos_lurk: 0,
                rechazo_usado: 0,
                ultimo_dia: null,
                titulos: [],
                evento_tipo: null,
                evento_fase: null,
                evento_fruta: null,
                evento_nivel: null,
                evento_estado: null,
                evento_comandos: null
                op_usos_hoy: 0,
                ultimo_op_fecha: null,
                ultimo_op_timestamp: null,
                racha_ops: 0,
                ultimo_dia_racha: null,
                supremos_min_historico: 0
            }])
            .select()
            .single();

        if (insertError) {
            console.error('❌ Error al crear usuario:', insertError);
            console.error('❌ Detalles del error:', JSON.stringify(insertError, null, 2));
            return null;
        }

        console.log(`✅ Usuario "${username}" creado exitosamente.`);
        return newUser;
    }

    console.log(`✅ Usuario "${username}" encontrado.`);
    return data[0];
}

async function updateUsuario(username, datos) {
    console.log(`🔍 updateUsuario llamado con username: "${username}"`);
    console.log(`🔍 Datos recibidos:`, JSON.stringify(datos, null, 2));

    const { data, error } = await supabase
        .from('usuarios')
        .update(datos)
        .eq('username', username)
        .select();

    if (error) {
        console.error('❌ ERROR en updateUsuario:', error);
        return null;
    }

    console.log(`✅ Datos devueltos por Supabase:`, JSON.stringify(data, null, 2));
    return data;
}

module.exports = { getUsuario, updateUsuario, supabase };