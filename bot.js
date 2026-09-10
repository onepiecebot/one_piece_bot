const tmi = require('tmi.js');
const config = require('./config.js');
const { getUsuario, updateUsuario, supabase } = require('./database.js');

// ============================================
// FUNCIONES DE RANGO DE ARMADURA
// ============================================

function getRangoArmadura(puntos, esSupremo = false) {
    if (esSupremo) return { nombre: 'Supremo', factor: 1.0, emoji: '👑' };
    if (puntos >= 100) return { nombre: 'Avanzado Élite', factor: 0.8, emoji: '💪' };
    if (puntos >= 80) return { nombre: 'Avanzado', factor: 0.8, emoji: '💪' };
    if (puntos >= 50) return { nombre: 'Básico', factor: 0.5, emoji: '✅' };
    if (puntos >= 20) return { nombre: 'Despertado', factor: 0.2, emoji: '👁️' };
    return { nombre: 'No despertado', factor: 0, emoji: '❌' };
}

function getIntervaloTirada(rango) {
    switch (rango) {
        case 'No despertado': return { min: 1, max: 5 };
        case 'Despertado': return { min: -1, max: 4 };
        case 'Básico': return { min: -2, max: 3 };
        case 'Avanzado': return { min: -3, max: 4 };
        case 'Avanzado Élite': return { min: -3, max: 3 };
        case 'Supremo': return { min: -4, max: 2 };
        default: return { min: 0, max: 0 };
    }
}

function tiradaAleatoria(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================
// COOLDOWNS
// ============================================
const cooldowns = {};
const COOLDOWN_FRUTA = 60000; // 1 minuto (para pruebas)

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
    channels: [config.channelName, 'op_d_bot']
});

client.connect().then(() => {
    console.log(`Bot conectado como ${config.botName} en el canal #${config.channelName}`);
}).catch(err => console.error('Error al conectar:', err));

// ============================================
// SISTEMA DE COMBATE
// ============================================

function calcularPoderHakis(armadura, observacion, conquistador) {
    const factorArmadura = armadura <= 0 ? 0 : armadura <= 19 ? 0 : armadura <= 49 ? 0.2 : armadura <= 79 ? 0.5 : armadura <= 99 ? 0.8 : 1.0;
    const factorObservacion = observacion <= 0 ? 0 : observacion <= 19 ? 0 : observacion <= 49 ? 0.2 : observacion <= 79 ? 0.5 : observacion <= 99 ? 0.8 : 1.0;
    const factorConquistador = conquistador <= 49 ? 0 : conquistador <= 79 ? 0.1 : conquistador <= 94 ? 0.25 : conquistador <= 100 ? 0.5 : 1.0;

    console.log(`🔍 Factores: Armadura=${factorArmadura}, Observacion=${factorObservacion}, Conquistador=${factorConquistador}`);

    const poderHakis = (armadura * factorArmadura * 2.5) + (observacion * factorObservacion * 1.8) + (conquistador * factorConquistador * 4.0);
    console.log(`🔍 PoderHakis: ${poderHakis}`);
    return poderHakis;
}

function calcularPoderBase(poderFruta, armadura, observacion, conquistador) {
    const poderHakis = calcularPoderHakis(armadura, observacion, conquistador);
    const poderBase = poderFruta + poderHakis;
    console.log(`🔍 PoderFruta: ${poderFruta} | PoderBase: ${poderBase}`);
    return poderBase;
}

function aplicarVariacion(poder) {
    const random = Math.floor(Math.random() * 101);
    const variacion = (950 + random) / 1000;
    const resultado = poder * variacion;
    console.log(`🔍 Variación aplicada: ${((variacion - 1) * 100).toFixed(1)}% → Poder final: ${resultado.toFixed(2)}`);
    return resultado;
}

function calcularCombate(poderUsuario, poderEnemigo) {
    const poderFinalUsuario = aplicarVariacion(poderUsuario);
    const poderFinalEnemigo = aplicarVariacion(poderEnemigo);
    const victoria = poderFinalUsuario > poderFinalEnemigo;
    const diferencia = poderFinalUsuario - poderFinalEnemigo;
    const porcentaje = (diferencia / poderFinalEnemigo) * 100;
    console.log(`🔍 Resultado: Victoria=${victoria}, Diferencia=${diferencia.toFixed(2)} (${porcentaje.toFixed(2)}%)`);
    return { victoria, diferencia, porcentaje, poderFinalUsuario, poderFinalEnemigo };
}

function obtenerMensaje(victoria, porcentaje) {
    const categoria = victoria ? 'victoria' : 'derrota';
    let rango = '';
    const absP = Math.abs(porcentaje);
    if (absP > 50) rango = 'aplastante';
    else if (absP >= 20) rango = 'clara';
    else if (absP >= 5) rango = 'ajustada';
    else if (absP >= 0) rango = 'por_los_pelos';

    const mensajes = {
        victoria: {
            aplastante: [
                '¡VICTORIA ARROLLADORA! Tu poder es abrumador. El enemigo apenas puede mantenerse en pie antes de caer derrotado. La audiencia enmudece ante semejante despliegue de fuerza.',
                '¡HAS DEVASTADO A TU RIVAL! Cada golpe era una sentencia. El enemigo no ha tenido oportunidad ni de reaccionar.'
            ],
            clara: [
                '¡VICTORIA CONTUNDENTE! Has dominado el combate de principio a fin. El enemigo ha luchado con honor, pero tu poder era muy superior.',
                '¡TRIUNFO SIN DISCUSIÓN! Te has impuesto con autoridad. El rival ha reconocido tu superioridad.'
            ],
            ajustada: [
                '¡VICTORIA SUDADA! Has ganado, pero no ha sido fácil. Has tenido que emplearte a fondo para superar a tu rival.',
                '¡VICTORIA POR LOS JUSTOS! El combate ha sido igualado, pero tu determinación ha sido mayor.'
            ],
            por_los_pelos: [
                '¡VICTORIA AGÓNICA! Literalmente has ganado por un pelo. El enemigo ha caído justo cuando se disponía a atacar. ¡Menudo respiro!',
                '¡VICTORIA MILAGROSA! Has ganado por centímetros. El destino ha estado de tu lado hoy.'
            ]
        },
        derrota: {
            aplastante: [
                'DERROTA ANIQUILADORA. El enemigo te ha superado con una facilidad pasmosa. Ni siquiera has podido reaccionar a sus movimientos.',
                'HAS SIDO BARRIDO. Tu oponente era de otro nivel. Vuelve a entrenar y busca la revancha.'
            ],
            clara: [
                'DERROTA CLARA. Has luchado con valor, pero el enemigo ha sido claramente superior. La diferencia de poder era evidente.',
                'DERROTA SIN PALIATIVOS. Has dado todo, pero el rival ha sido demasiado fuerte hoy.'
            ],
            ajustada: [
                'DERROTA AJUSTADA. Has estado a punto de ganar. El combate ha sido igualado, pero en el momento clave el enemigo ha sido más listo.',
                'DERROTA POR POCO. Has peleado bien, pero te ha faltado un último esfuerzo.'
            ],
            por_los_pelos: [
                'DERROTA POR LOS PELOS. Has perdido por un suspiro. El enemigo ha caído justo después de su ataque, pero ha sido él quien se ha levantado primero.',
                'DERROTA INEXTREMIS. Has estado a punto de ganar. La diferencia ha sido mínima.'
            ]
        }
    };

    const pool = mensajes[categoria][rango] || mensajes[categoria]['ajustada'];
    return pool[Math.floor(Math.random() * pool.length)];
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
            if (pts <= 19) return 'No despertado';
            if (pts <= 49) return 'Despertado';
            if (pts <= 79) return 'Básico';
            if (pts <= 99) return 'Avanzado';
            return 'Avanzado Élite';
        };
        const fruta = user && user.fruta ? user.fruta : 'Ninguna';
        const respuesta = `@${target} | Fruta: ${fruta} | Haki Armadura: ${rango(user && user.armadura ? user.armadura : 0)} | Haki Observacion: ${rango(user && user.observacion ? user.observacion : 0)} | Haki Conquistador: ${rango(user && user.conquistador ? user.conquistador : 0)}`;
        client.say(channel, respuesta);
        return;
    }

    // ============================================
    // !op (VERSIÓN TEMPORAL - SE ACTUALIZARÁ EN EL SIGUIENTE PASO)
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
            const segundos = Math.ceil(tiempoRestante / 1000);
            client.say(channel, `@${tags.username} Debes esperar ${segundos} segundos para usar !fruta nuevamente.`);
            return;
        }

        // Verificar evento pendiente
        if (user && user.evento_estado === 'pendiente') {
            client.say(channel, `@${tags.username} Ya tienes un evento pendiente. Usa !pendiente para ver la decisión que debes tomar.`);
            return;
        }

        // Verificar si ya tiene fruta
        if (user && user.fruta) {
            client.say(channel, `@${tags.username} Ya tienes una fruta (${user.fruta}). Usa !rechazar si quieres liberarla.`);
            return;
        }

        // Racha activa para pruebas
        const tieneRacha = true;
        if (!tieneRacha) {
            client.say(channel, `@${tags.username} Necesitas tener la racha activa para buscar una fruta.`);
            return;
        }

        // Probabilidad general (5%)
        const probGeneral = 5;
        if (Math.random() * 100 > probGeneral) {
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

        // Obtener frutas disponibles
        const { data: usuariosConFruta } = await supabase.from('usuarios').select('fruta').not('fruta', 'is', null);
        const frutasOcupadas = (usuariosConFruta || []).map(u => u.fruta);
        const { data: frutasDisponibles, error: errorFrutas } = await supabase
            .from('frutas')
            .select('*')
            .not('nombre', 'in', `(${frutasOcupadas.map(f => `'${f}'`).join(',')})`);

        if (errorFrutas || !frutasDisponibles || frutasDisponibles.length === 0) {
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No hay frutas disponibles en este momento. ¡Vuelve más tarde!`);
            return;
        }

        // Selección ponderada
        const totalProb = frutasDisponibles.reduce((sum, f) => sum + f.probabilidad, 0);
        let randomPick = Math.random() * totalProb;
        let selectedFruit = null;
        for (const fruta of frutasDisponibles) {
            randomPick -= fruta.probabilidad;
            if (randomPick <= 0) { selectedFruit = fruta; break; }
        }

        if (!selectedFruit) {
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

        cooldowns[`fruta_${username}`] = Date.now();

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
    // !pendiente
    // ============================================
    if (command === '!pendiente') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente') {
            client.say(channel, `@${tags.username} No tienes ningún evento pendiente.`);
            return;
        }
        const { data: fruta } = await supabase
            .from('frutas')
            .select('fase1, fase2')
            .eq('nombre', user.evento_fruta)
            .single();
        if (!fruta) {
            client.say(channel, `@${tags.username} Error al obtener detalles del evento.`);
            return;
        }
        const texto = user.evento_fase === 'avistamiento' ? fruta.fase1 : fruta.fase2;
        client.say(channel, `@${tags.username} ${texto}`);
        return;
    }

    // ============================================
    // !testevento
    // ============================================
    if (command === '!testevento') {
        await updateUsuario(username, {
            evento_tipo: null, evento_fase: null, evento_fruta: null,
            evento_nivel: null, evento_estado: null, evento_comandos: null
        });
        const { data: fruta, error } = await supabase
            .from('frutas')
            .select('*')
            .eq('nombre', 'Mera Mera no Mi')
            .single();
        if (error || !fruta) {
            client.say(channel, `@${tags.username} Error al cargar el evento de prueba.`);
            return;
        }
        await updateUsuario(username, {
            evento_tipo: 'fruta',
            evento_fase: 'avistamiento',
            evento_fruta: fruta.nombre,
            evento_nivel: fruta.nivel || 1,
            evento_estado: 'pendiente',
            evento_comandos: 'si_no'
        });
        client.say(channel, `@${tags.username} [TEST] Has encontrado un evento. ${fruta.fase1}`);
        return;
    }

    // ============================================
    // !si
    // ============================================
    if (command === '!si') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }
        await updateUsuario(username, { evento_fase: 'encuentro', evento_comandos: 'pelear_huir' });
        const { data: fruta } = await supabase
            .from('frutas')
            .select('fase2')
            .eq('nombre', user.evento_fruta)
            .single();
        client.say(channel, `@${tags.username} ${fruta.fase2}`);
        return;
    }

    // ============================================
    // !no
    // ============================================
    if (command === '!no') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_fase !== 'avistamiento') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }
        await updateUsuario(username, {
            evento_tipo: null, evento_fase: null, evento_fruta: null,
            evento_nivel: null, evento_estado: null, evento_comandos: null
        });
        client.say(channel, `@${tags.username} Decides retirarte. El evento ha terminado.`);
        return;
    }

    // ============================================
    // !pelear
    // ============================================
    if (command === '!pelear') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }

        const { data: frutaData } = await supabase
            .from('frutas')
            .select('poder_fruta, sombra')
            .eq('nombre', user.evento_fruta)
            .single();

        const poderFrutaUsuario = frutaData ? frutaData.poder_fruta : 0;
        const nombreSombra = frutaData ? frutaData.sombra : null;

        const armadura = user.armadura || 0;
        const observacion = user.observacion || 0;
        const conquistador = user.conquistador || 0;

        console.log(`🔍 Hakis: Armadura=${armadura}, Observacion=${observacion}, Conquistador=${conquistador}`);

        const poderUsuario = calcularPoderBase(poderFrutaUsuario, armadura, observacion, conquistador);

        let poderEnemigoBase = 80;
        let npcNombre = '';

        if (nombreSombra) {
            const { data: npc, error: npcError } = await supabase
                .from('npcs')
                .select('pcf_final, pcf_calculado, nivel')
                .eq('nombre', nombreSombra)
                .maybeSingle();

            if (npcError || !npc) {
                console.warn(`⚠️ NPC ${nombreSombra} no encontrado. Usando 80.`);
                poderEnemigoBase = 80;
            } else {
                poderEnemigoBase = npc.pcf_final || npc.pcf_calculado || 80;
                npcNombre = nombreSombra;
            }
        } else {
            const nivel = user.evento_nivel || 4;
            poderEnemigoBase = 20 + nivel * 15;
            npcNombre = 'enemigo genérico';
        }

        console.log(`🔍 Poder Enemigo Base: ${poderEnemigoBase}`);

        const resultado = calcularCombate(poderUsuario, poderEnemigoBase);

        const nivel = user.evento_nivel || 4;
        const baseConquistador = nivel * 5;
        const baseBerries = nivel * 1000000;
        const recompensaConq = resultado.victoria ? baseConquistador : -Math.floor(baseConquistador / 2);
        const recompensaBerries = resultado.victoria ? baseBerries : -Math.floor(baseBerries / 4);

        const mensaje = obtenerMensaje(resultado.victoria, resultado.porcentaje);

        await updateUsuario(username, {
            conquistador: (user.conquistador || 0) + recompensaConq,
            recompensa_publica: (user.recompensa_publica || 0) + recompensaBerries,
            fruta: resultado.victoria ? user.evento_fruta : null,
            evento_tipo: null,
            evento_fase: null,
            evento_fruta: null,
            evento_nivel: null,
            evento_estado: null,
            evento_comandos: null
        });

        const resultadoTexto = resultado.victoria
            ? `¡Has ganado! Tu poder base: ${poderUsuario.toFixed(0)} | Final: ${resultado.poderFinalUsuario.toFixed(0)} | Enemigo: ${poderEnemigoBase} → ${resultado.poderFinalEnemigo.toFixed(0)} | Diferencia: ${resultado.diferencia.toFixed(0)} (${resultado.porcentaje.toFixed(1)}%)`
            : `Has perdido. Tu poder base: ${poderUsuario.toFixed(0)} | Final: ${resultado.poderFinalUsuario.toFixed(0)} | Enemigo: ${poderEnemigoBase} → ${resultado.poderFinalEnemigo.toFixed(0)} | Diferencia: ${resultado.diferencia.toFixed(0)} (${resultado.porcentaje.toFixed(1)}%)`;

        client.say(channel, `@${tags.username} ${mensaje} ${resultadoTexto}`);
        return;
    }

    // ============================================
    // !huir
    // ============================================
    if (command === '!huir') {
        const user = await getUsuario(username);
        if (!user || user.evento_estado !== 'pendiente' || user.evento_fase !== 'encuentro') {
            client.say(channel, `@${tags.username} No tienes un evento de fruta pendiente en esta fase.`);
            return;
        }
        await updateUsuario(username, {
            evento_tipo: null, evento_fase: null, evento_fruta: null,
            evento_nivel: null, evento_estado: null, evento_comandos: null
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
    if (!esDueño(username)) return;

    if (command === '!sumar1') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar1 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { armadura: (user.armadura || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de armadura a @${target}. Ahora tiene ${user.armadura + cantidad}.`);
        return;
    }
    if (command === '!sumar2') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar2 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { observacion: (user.observacion || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de observación a @${target}. Ahora tiene ${user.observacion + cantidad}.`);
        return;
    }
    if (command === '!sumar3') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar3 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { conquistador: (user.conquistador || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} puntos de conquistador a @${target}. Ahora tiene ${user.conquistador + cantidad}.`);
        return;
    }
    if (command === '!restar1') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !restar1 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        const nuevo = Math.max((user.armadura || 0) - cantidad, 0);
        await updateUsuario(target, { armadura: nuevo });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de armadura a @${target}. Ahora tiene ${nuevo}.`);
        return;
    }
    if (command === '!restar2') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !restar2 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        const nuevo = Math.max((user.observacion || 0) - cantidad, 0);
        await updateUsuario(target, { observacion: nuevo });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de observación a @${target}. Ahora tiene ${nuevo}.`);
        return;
    }
    if (command === '!restar3') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !restar3 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        const nuevo = Math.max((user.conquistador || 0) - cantidad, 0);
        await updateUsuario(target, { conquistador: nuevo });
        client.say(channel, `@${tags.username} Has restado ${cantidad} puntos de conquistador a @${target}. Ahora tiene ${nuevo}.`);
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
        if (args.length < 3) {
            client.say(channel, `@${tags.username} Uso: !setpcf nombreNPC poder`);
            return;
        }
        const npcNombre = args[1].toLowerCase();
        const nuevoPoder = parseInt(args[2]);
        if (isNaN(nuevoPoder) || nuevoPoder < 0) {
            client.say(channel, `@${tags.username} El poder debe ser un número positivo.`);
            return;
        }

        const { data: npcExistente, error: searchError } = await supabase
            .from('npcs')
            .select('*')
            .eq('nombre', npcNombre)
            .maybeSingle();

        if (searchError) {
            console.error('Error al buscar NPC:', searchError);
            client.say(channel, `@${tags.username} Error al buscar el enemigo.`);
            return;
        }

        if (npcExistente) {
            const { error: updateError } = await supabase
                .from('npcs')
                .update({ pcf_final: nuevoPoder })
                .eq('nombre', npcNombre);
            if (updateError) {
                console.error('Error al actualizar NPC:', updateError);
                client.say(channel, `@${tags.username} Error al actualizar el poder.`);
                return;
            }
        } else {
            const { error: insertError } = await supabase
                .from('npcs')
                .insert([{ nombre: npcNombre, pcf_final: nuevoPoder, nivel: 4 }]);
            if (insertError) {
                console.error('Error al insertar NPC:', insertError);
                client.say(channel, `@${tags.username} Error al crear el enemigo.`);
                return;
            }
        }

        client.say(channel, `@${tags.username} Has cambiado el PCF de ${npcNombre} a ${nuevoPoder}.`);
        return;
    }
});

console.log('Bot escuchando...');