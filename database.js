const fs = require('fs');
const path = './users.json';

function leerUsuarios() {
    if (!fs.existsSync(path)) {
        fs.writeFileSync(path, JSON.stringify({}));
        return {};
    }
    const data = fs.readFileSync(path);
    return JSON.parse(data);
}

function guardarUsuarios(users) {
    fs.writeFileSync(path, JSON.stringify(users, null, 2));
}

function getUsuario(username) {
    let users = leerUsuarios();
    if (!users[username]) {
        users[username] = {
            armadura: 0,
            observacion: 0,
            conquistador: 0,
            fruta: null,
            racha_dia: 0,
            ultimo_comando: 0,
            minutos_lurk: 0,
            rechazo_usado: 0,
            ultimo_dia: null
        };
        guardarUsuarios(users);
    }
    return users[username];
}

function updateUsuario(username, datos) {
    let users = leerUsuarios();
    if (!users[username]) users[username] = {};
    Object.assign(users[username], datos);
    guardarUsuarios(users);
}

module.exports = { getUsuario, updateUsuario };