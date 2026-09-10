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

function getBonusDiario(rango) {
    switch (rango) {
        case 'No despertado': return 5;
        case 'Despertado': return 4;
        case 'Básico': return 3;
        case 'Avanzado':
        case 'Avanzado Élite': return 2;
        case 'Supremo': return 1;
        default: return 0;
    }
}

function getBonusRacha(dias) {
    if (dias % 10 === 0) return 10;
    if (dias % 5 === 0) return 5;
    return 1;
}

function getTextoResultado(rango, delta) {
    if (delta > 0) {
        switch (rango) {
            case 'No despertado': return '¡Sentís una chispa interior!';
            case 'Despertado': return '¡Tu espíritu se enciende!';
            case 'Básico': return '¡Tu cuerpo se vuelve más duro!';
            case 'Avanzado':
            case 'Avanzado Élite': return '¡Tu voluntad es inquebrantable!';
            case 'Supremo': return '¡Nadie puede detenerte!';
            default: return '¡Has entrenado!';
        }
    } else if (delta < 0) {
        switch (rango) {
            case 'No despertado': return 'Tu Haki se resiste...';
            case 'Despertado': return 'El entrenamiento fue duro...';
            case 'Básico': return 'Golpeaste mal y perdiste fuerza...';
            case 'Avanzado':
            case 'Avanzado Élite': return 'Tu Armadura flaqueó un instante...';
            case 'Supremo': return 'Hasta los más fuertes fallan...';
            default: return 'Perdiste fuerza...';
        }
    } else {
        switch (rango) {
            case 'No despertado': return 'Nada cambió... pero no te rindas.';
            case 'Despertado': return 'Tu Haki está estable.';
            case 'Básico': return 'Hoy no hubo cambios, pero seguís firme.';
            case 'Avanzado':
            case 'Avanzado Élite': return 'Nada te mueve, ni siquiera la suerte.';
            case 'Supremo': return 'Nada puede tocarte, ni el azar.';
            default: return 'Sin cambios.';
        }
    }
}

function getMensajeNuevoRango(rango, usuario) {
    switch (rango) {
        case 'Despertado':
            return `👁️ ¡Felicidades ${usuario}! Tu Haki de Armadura ha despertado.`;
        case 'Básico':
            return `🛡️ ¡Tu defensa se vuelve confiable, ${usuario}! Nivel Básico alcanzado. ✅`;
        case 'Avanzado':
            return `⚔️ ¡Impresionante, ${usuario}! Tu Armadura tiene gran poder. Rango Avanzado. 💪`;
        case 'Supremo':
            return `🌊 ¡Como un emperador del mar, ${usuario} ha dominado el Haki de Armadura! Ahora es SUPREMO. 👑`;
        default:
            return '';
    }
}

function getFechaHoy() {
    const ahora = new Date();
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    return arg.toISOString().split('T')[0];
}

function getFechaAyer() {
    const ahora = new Date();
    ahora.setDate(ahora.getDate() - 1);
    const offsetArg = -3 * 60;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const arg = new Date(utc + (offsetArg * 60000));
    return arg.toISOString().split('T')[0];
}

// ============================================
// SISTEMA DE SUPREMOS DINÁMICOS
// ============================================

async function getSupremosActuales() {
    try {
        // 1. Contar dedicados (usuarios con op_usos_hoy > 0)
        const { data: dedicadosData, error: err1 } = await supabase
            .from('usuarios')
            .select('username')
            .gt('op_usos_hoy', 0);

        if (err1) {
            console.error('Error al contar dedicados:', err1);
            return [];
        }

        const numDedicados = (dedicadosData || []).length;

        // 2. Calcular plazas base
        const plazasBase = numDedicados === 0 ? 0 : Math.floor(numDedicados / 21) + 1;

        // 3. Obtener máximo de armadura
        const { data: maxData, error: err2 } = await supabase
            .from('usuarios')
            .select('armadura')
            .order('armadura', { ascending: false })
            .limit(1);

        if (err2) {
            console.error('Error al obtener max armadura:', err2);
            return [];
        }

        const maxArmadura = maxData && maxData[0] ? maxData[0].armadura : 0;

        // 4. Calcular plazas extra
        let plazasExtra = 0;
        if (maxArmadura >= 100) {
            plazasExtra = Math.floor((maxArmadura - 100) / 100) * 3;
        }

        // 5. Obtener mínimo histórico (guardado en el usuario del dueño)
        const { data: dueñoData } = await supabase
            .from('usuarios')
            .select('supremos_min_historico')
            .eq('username', 'fan_d_larana')
            .maybeSingle();

        const minHistorico = dueñoData?.supremos_min_historico || 0;

        // 6. Actualizar mínimo histórico si plazasBase lo supera
        if (plazasBase > minHistorico) {
            await supabase
                .from('usuarios')
                .update({ supremos_min_historico: plazasBase })
                .eq('username', 'fan_d_larana');
        }

        // 7. Plazas base efectivas (nunca bajan del mínimo histórico)
        const plazasBaseEfectivas = Math.max(plazasBase, minHistorico);

        // 8. Total de plazas
        let totalPlazas = Math.max(plazasBaseEfectivas, plazasExtra + 1);

        // Si no hay dedicados, solo se usan las plazas extra + histórico
        if (numDedicados === 0) {
            totalPlazas = Math.max(plazasExtra, minHistorico);
        }

        if (totalPlazas === 0) return [];

        // 9. Obtener los mejores usuarios con armadura >= 100
        const { data: topData, error: err3 } = await supabase
            .from('usuarios')
            .select('username, armadura')
            .gte('armadura', 100)
            .order('armadura', { ascending: false })
            .limit(totalPlazas);

        if (err3) {
            console.error('Error al obtener top supremos:', err3);
            return [];
        }

        return (topData || []).map(u => u.username.toLowerCase());
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
// COOLDOWNS
// ============================================
const cooldowns = {};
const COOLDOWN_FRUTA = 60000; // 1 minuto (para pruebas)

// ============================================
// ADMIN
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
    console.log(`Bot conectado como ${config.botName} en los canales #${config.channelName} y #op_d_bot`);
}).catch(err => console.error('Error al conectar:', err));

// ============================================
// SISTEMA DE COMBATE
// ============================================

function calcularPoderHakis(armadura, observacion, conquistador, esSupremoArmadura = false) {
    const factorArmadura = esSupremoArmadura ? 1.0 : (armadura <= 19 ? 0 : armadura <= 49 ? 0.2 : armadura <= 79 ? 0.5 : armadura <= 99 ? 0.8 : 1.0);
    const factorObservacion = observacion <= 19 ? 0 : observacion <= 49 ? 0.2 : observacion <= 79 ? 0.5 : observacion <= 99 ? 0.8 : 1.0;
    const factorConquistador = conquistador <= 49 ? 0 : conquistador <= 79 ? 0.1 : conquistador <= 94 ? 0.25 : conquistador <= 100 ? 0.5 : 1.0;

    const poderHakis = (armadura * factorArmadura * 2.5) + (observacion * factorObservacion * 1.8) + (conquistador * factorConquistador * 4.0);
    return poderHakis;
}

function calcularPoderBase(poderFruta, armadura, observacion, conquistador, esSupremoArmadura = false) {
    return poderFruta + calcularPoderHakis(armadura, observacion, conquistador, esSupremoArmadura);
}

function aplicarVariacion(poder) {
    const random = Math.floor(Math.random() * 101);
    return poder * (950 + random) / 1000;
}

function calcularCombate(poderUsuario, poderEnemigo) {
    const poderFinalUsuario = aplicarVariacion(poderUsuario);
    const poderFinalEnemigo = aplicarVariacion(poderEnemigo);
    const victoria = poderFinalUsuario > poderFinalEnemigo;
    const diferencia = poderFinalUsuario - poderFinalEnemigo;
    const porcentaje = (diferencia / poderFinalEnemigo) * 100;
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
        const esSupremoUser = await esSupremo(target);

        const rangoArm = getRangoArmadura(user && user.armadura ? user.armadura : 0, esSupremoUser);
        const rangoObs = getRangoArmadura(user && user.observacion ? user.observacion : 0, false);
        const rangoConq = (pts) => {
            if (pts <= 49) return 'No despertado';
            if (pts <= 79) return 'Despertado';
            if (pts <= 94) return 'Básico';
            if (pts <= 100) return 'Avanzado';
            return 'Supremo';
        };
        const fruta = user && user.fruta ? user.fruta : 'Ninguna';
        const respuesta = `@${target} | Fruta: ${fruta} | Haki Armadura: ${rangoArm.nombre} ${rangoArm.emoji} | Haki Observacion: ${rangoObs.nombre} | Haki Conquistador: ${rangoConq(user && user.conquistador ? user.conquistador : 0)}`;
        client.say(channel, respuesta);
        return;
    }

    // ============================================
    // !op (NUEVA LÓGICA)
    // ============================================
    if (command === '!op') {
        const user = await getUsuario(username);

        // 1. Cooldown de 10 minutos
        const ahora = Date.now();
        const ultimoTimestamp = user.ultimo_op_timestamp ? new Date(user.ultimo_op_timestamp).getTime() : 0;
        const tiempoCooldown = 10 * 60 * 1000;
        const tiempoRestante = tiempoCooldown - (ahora - ultimoTimestamp);
        if (tiempoRestante > 0) {
            const minutos = Math.floor(tiempoRestante / 60000);
            const segundos = Math.floor((tiempoRestante % 60000) / 1000);
            client.say(channel, `⏳ Todavía no podés entrenar. Te faltan ${minutos}m ${segundos}s para volver a usar !op.`);
            return;
        }

        // 2. Cambio de día y penalización
        const hoy = getFechaHoy();
        const ultimoDia = user.ultimo_op_fecha || null;

        if (ultimoDia !== hoy) {
            const usosAyer = user.op_usos_hoy || 0;
            const usosFaltantes = 3 - usosAyer;

            if (usosFaltantes > 0 && ultimoDia !== null) {
                let armaduraActual = user.armadura || 0;
                let deltaPenalizacion = 0;

                if (usosAyer === 0 && armaduraActual < 20) {
                    deltaPenalizacion = -1;
                    armaduraActual = Math.max(armaduraActual - 1, 0);
                } else {
                    for (let i = 0; i < usosFaltantes; i++) {
                        const rangoActual = getRangoArmadura(armaduraActual);
                        const intervalo = getIntervaloTirada(rangoActual.nombre);
                        const peorResultado = Math.min(intervalo.min, intervalo.max);
                        deltaPenalizacion += peorResultado;
                        armaduraActual = Math.max(armaduraActual + peorResultado, 0);
                    }
                }

                if (deltaPenalizacion !== 0) {
                    client.say(channel, `💤 Descuidaste tu entrenamiento. Perdiste ${Math.abs(deltaPenalizacion)} de Haki de Armadura. ${getRangoArmadura(armaduraActual).emoji}`);
                }

                await updateUsuario(username, {
                    armadura: armaduraActual,
                    op_usos_hoy: 0,
                    ultimo_op_fecha: hoy,
                    racha_ops: 0
                });
            } else {
                await updateUsuario(username, {
                    op_usos_hoy: 0,
                    ultimo_op_fecha: hoy
                });
            }
        }

        // 3. Recargar usuario
        const userAct = await getUsuario(username);

        // 4. Verificar límite diario
        if ((userAct.op_usos_hoy || 0) >= 3) {
            client.say(channel, `Tu cuerpo llegó al límite por hoy. Descansá y mañana seguís.`);
            return;
        }

        // 5. Rango actual y tirada
        const armaduraActual = userAct.armadura || 0;
        const eraSupremo = await esSupremo(username);
        const rangoActual = getRangoArmadura(armaduraActual, eraSupremo);
        const intervalo = getIntervaloTirada(rangoActual.nombre);
        const delta = tiradaAleatoria(intervalo.min, intervalo.max);

        // 6. Nueva armadura y rango
        const nuevaArmadura = Math.max(armaduraActual + delta, 0);

        // 7. Actualizar datos
        const nuevosUsos = (userAct.op_usos_hoy || 0) + 1;
        const esTerceraTirada = nuevosUsos === 3;

        const updateData = {
            armadura: nuevaArmadura,
            op_usos_hoy: nuevosUsos,
            ultimo_op_fecha: hoy,
            ultimo_op_timestamp: new Date().toISOString()
        };

        let bonusTotal = 0;
        let mensajesExtra = [];

        if (esTerceraTirada) {
            const bonusDiario = getBonusDiario(rangoActual.nombre);
            bonusTotal += bonusDiario;
            mensajesExtra.push(`🔥 Completaste tu entrenamiento diario: +${bonusDiario} de Haki de Armadura.`);

            const fechaAyer = getFechaAyer();
            const ultimoDiaRacha = userAct.ultimo_dia_racha || null;
            let rachaActual = userAct.racha_ops || 0;

            if (ultimoDiaRacha === fechaAyer) {
                rachaActual += 1;
            } else {
                rachaActual = 1;
            }

            const bonusRacha = getBonusRacha(rachaActual);
            bonusTotal += bonusRacha;
            mensajesExtra.push(`🔥 Racha de ${rachaActual} días: +${bonusRacha} extra.`);

            updateData.armadura = nuevaArmadura + bonusTotal;
            updateData.racha_ops = rachaActual;
            updateData.ultimo_dia_racha = hoy;
        }

        await updateUsuario(username, updateData);

        // 8. Verificar si ahora es Supremo
        const ahoraSupremo = await esSupremo(username);
        const armaduraFinal = updateData.armadura;
        const rangoFinal = getRangoArmadura(armaduraFinal, ahoraSupremo);

        // 9. Construir mensaje
        const textoResultado = getTextoResultado(rangoFinal.nombre, delta);
        let respuesta = `@${tags.username} ${textoResultado} ${delta > 0 ? '+' : ''}${delta} de Haki de Armadura ${rangoFinal.emoji}`;

        // Cambio de rango
        const rangoAnterior = eraSupremo ? 'Supremo' : getRangoArmadura(armaduraActual).nombre;
        if (rangoAnterior !== rangoFinal.nombre) {
            const msgRango = getMensajeNuevoRango(rangoFinal.nombre, tags.username);
            if (msgRango) respuesta += ` | ${msgRango}`;
        }

        if (esTerceraTirada && mensajesExtra.length > 0) {
            respuesta += ` | ${mensajesExtra.join(' | ')}`;
        }

        client.say(channel, respuesta);
        return;
    }

    // ============================================
    // !fruta
    // ============================================
    if (command === '!fruta') {
        const user = await getUsuario(username);

        const ahora = Date.now();
        const ultimoUso = cooldowns[`fruta_${username}`] || 0;
        const tiempoRestante = COOLDOWN_FRUTA - (ahora - ultimoUso);
        if (tiempoRestante > 0) {
            const segundos = Math.ceil(tiempoRestante / 1000);
            client.say(channel, `@${tags.username} Debes esperar ${segundos} segundos para usar !fruta nuevamente.`);
            return;
        }

        if (user && user.evento_estado === 'pendiente') {
            client.say(channel, `@${tags.username} Ya tienes un evento pendiente. Usa !pendiente para ver la decisión que debes tomar.`);
            return;
        }

        if (user && user.fruta) {
            client.say(channel, `@${tags.username} Ya tienes una fruta (${user.fruta}). Usa !rechazar si quieres liberarla.`);
            return;
        }

        const tieneRacha = true;

        const probGeneral = 5;
        if (Math.random() * 100 > probGeneral) {
            cooldowns[`fruta_${username}`] = Date.now();
            client.say(channel, `@${tags.username} No tuviste suerte esta vez. ¡Suerte para la próxima!`);
            return;
        }

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
        const esSupremoUser = await esSupremo(username);

        const poderUsuario = calcularPoderBase(poderFrutaUsuario, armadura, observacion, conquistador, esSupremoUser);

        let poderEnemigoBase = 80;

        if (nombreSombra) {
            const { data: npc, error: npcError } = await supabase
                .from('npcs')
                .select('pcf_final, pcf_calculado, nivel')
                .eq('nombre', nombreSombra)
                .maybeSingle();

            if (npcError || !npc) {
                poderEnemigoBase = 80;
            } else {
                poderEnemigoBase = npc.pcf_final || npc.pcf_calculado || 80;
            }
        } else {
            const nivel = user.evento_nivel || 4;
            poderEnemigoBase = 20 + nivel * 15;
        }

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
            ? `¡Has ganado! Poder: ${poderUsuario.toFixed(0)} → ${resultado.poderFinalUsuario.toFixed(0)} | Enemigo: ${poderEnemigoBase} → ${resultado.poderFinalEnemigo.toFixed(0)} | Dif: ${resultado.diferencia.toFixed(0)} (${resultado.porcentaje.toFixed(1)}%)`
            : `Has perdido. Poder: ${poderUsuario.toFixed(0)} → ${resultado.poderFinalUsuario.toFixed(0)} | Enemigo: ${poderEnemigoBase} → ${resultado.poderFinalEnemigo.toFixed(0)} | Dif: ${resultado.diferencia.toFixed(0)} (${resultado.porcentaje.toFixed(1)}%)`;

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
    // COMANDOS DE ADMIN
    // ============================================
    if (!esDueño(username)) return;

    if (command === '!sumar1') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar1 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { armadura: (user.armadura || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} de armadura a @${target}. Ahora tiene ${user.armadura + cantidad}.`);
        return;
    }
    if (command === '!sumar2') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar2 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { observacion: (user.observacion || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} de observación a @${target}. Ahora tiene ${user.observacion + cantidad}.`);
        return;
    }
    if (command === '!sumar3') {
        if (args.length < 3) return client.say(channel, `@${tags.username} Uso: !sumar3 @usuario cantidad`);
        const target = args[1].replace('@', '').toLowerCase();
        const cantidad = parseInt(args[2]);
        if (isNaN(cantidad)) return client.say(channel, `@${tags.username} La cantidad debe ser un número.`);
        const user = await getUsuario(target);
        await updateUsuario(target, { conquistador: (user.conquistador || 0) + cantidad });
        client.say(channel, `@${tags.username} Has sumado ${cantidad} de conquistador a @${target}. Ahora tiene ${user.conquistador + cantidad}.`);
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
        client.say(channel, `@${tags.username} Has restado ${cantidad} de armadura a @${target}. Ahora tiene ${nuevo}.`);
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
        client.say(channel, `@${tags.username} Has restado ${cantidad} de observación a @${target}. Ahora tiene ${nuevo}.`);
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
        client.say(channel, `@${tags.username} Has restado ${cantidad} de conquistador a @${target}. Ahora tiene ${nuevo}.`);
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
            client.say(channel, `@${tags.username} Error al buscar el enemigo.`);
            return;
        }

        if (npcExistente) {
            const { error: updateError } = await supabase
                .from('npcs')
                .update({ pcf_final: nuevoPoder })
                .eq('nombre', npcNombre);
            if (updateError) {
                client.say(channel, `@${tags.username} Error al actualizar el poder.`);
                return;
            }
        } else {
            const { error: insertError } = await supabase
                .from('npcs')
                .insert([{ nombre: npcNombre, pcf_final: nuevoPoder, nivel: 4 }]);
            if (insertError) {
                client.say(channel, `@${tags.username} Error al crear el enemigo.`);
                return;
            }
        }

        client.say(channel, `@${tags.username} Has cambiado el PCF de ${npcNombre} a ${nuevoPoder}.`);
        return;
    }
});

console.log('Bot escuchando...');