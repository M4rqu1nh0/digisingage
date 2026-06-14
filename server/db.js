'use strict';

/**
 * Capa de acceso a datos (SQLite via better-sqlite3).
 *
 * better-sqlite3 es sincrono: simplifica enormemente el codigo (no hay
 * callbacks ni promesas) y es mas que suficiente para la carga de un
 * sistema de carteleria con decenas/cientos de dispositivos.
 *
 * MULTI-TENANT:
 *   empresas(id, nombre, pairing_code, activa, created_at)
 *   usuarios(id, empresa_id, usuario, password_hash, rol, activo, created_at)
 *   dispositivos(id, empresa_id, nombre, ultima_conexion, ip_actual)
 *   playlists(id, dispositivo_id, video_url_o_nombre, orden)        -- acotado via dispositivo
 *   image_playlists(id, dispositivo_id, imagen, orden)              -- acotado via dispositivo
 *
 * Cada empresa administra de forma privada sus dispositivos, medios y usuarios.
 * El aislamiento se aplica SIEMPRE filtrando por empresa_id en la capa de datos.
 */

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const layouts = require('./layouts');

// Ruta configurable (util para tests y para un disco persistente en Render).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'signage.db');
const db = new Database(DB_PATH);

// WAL mejora la concurrencia lectura/escritura (muchos heartbeats simultaneos).
db.pragma('journal_mode = WAL');

// --- Creacion del esquema (idempotente) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id            TEXT PRIMARY KEY,
    nombre        TEXT NOT NULL,
    pairing_code  TEXT NOT NULL UNIQUE,
    activa        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
  );

  -- Nombre unico (case-insensitive): permite identificar la empresa en el login.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_nombre
    ON empresas (nombre COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS usuarios (
    id            TEXT PRIMARY KEY,
    empresa_id    TEXT,                    -- NULL solo para super_admin
    usuario       TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    rol           TEXT NOT NULL,           -- 'super_admin' | 'admin' | 'operador'
    activo        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    UNIQUE (empresa_id, usuario)
  );

  CREATE TABLE IF NOT EXISTS dispositivos (
    id               TEXT PRIMARY KEY,
    nombre           TEXT NOT NULL DEFAULT 'Sin nombre',
    ultima_conexion  TEXT,            -- ISO 8601 (UTC)
    ip_actual        TEXT
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dispositivo_id      TEXT NOT NULL,
    video_url_o_nombre  TEXT NOT NULL,
    orden               INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (dispositivo_id) REFERENCES dispositivos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playlists_disp
    ON playlists (dispositivo_id, orden);

  CREATE TABLE IF NOT EXISTS image_playlists (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dispositivo_id      TEXT NOT NULL,
    imagen              TEXT NOT NULL,
    orden               INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (dispositivo_id) REFERENCES dispositivos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_image_playlists_disp
    ON image_playlists (dispositivo_id, orden);
`);

// --- Migracion: anade empresa_id a dispositivos si la BD es antigua ---
const dispCols = db.prepare('PRAGMA table_info(dispositivos)').all();
if (!dispCols.some((c) => c.name === 'empresa_id')) {
  db.exec('ALTER TABLE dispositivos ADD COLUMN empresa_id TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_dispositivos_empresa ON dispositivos (empresa_id)');

// --- Migracion: anade layout_json a dispositivos (layout por widgets/zonas) ---
if (!dispCols.some((c) => c.name === 'layout_json')) {
  db.exec('ALTER TABLE dispositivos ADD COLUMN layout_json TEXT');
}

// --- Migracion: unicidad GLOBAL del nombre de usuario ---
// El login se hace solo con usuario + contrasena (sin empresa), asi que el
// nombre de usuario debe identificar a UNA sola cuenta en todo el sistema
// (un usuario no puede pertenecer a dos empresas). Si una BD antigua tuviera
// el mismo nombre repetido en distintas empresas, abortamos con un mensaje
// claro en vez de fallar de forma criptica al crear el indice unico.
{
  const dupUsers = db
    .prepare('SELECT usuario FROM usuarios GROUP BY usuario COLLATE NOCASE HAVING COUNT(*) > 1')
    .all();
  if (dupUsers.length) {
    throw new Error(
      'No se puede aplicar la unicidad global de usuarios: hay nombres repetidos en ' +
        'distintas empresas (' + dupUsers.map((d) => d.usuario).join(', ') + '). ' +
        'Renombralos para que cada usuario sea unico antes de actualizar.'
    );
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios (usuario COLLATE NOCASE)'
  );
}

// ----------------------------- Hashing (scrypt) -----------------------------
// Sin dependencias nativas: usamos crypto.scrypt (incluido en Node).

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${dk}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const keyBuf = Buffer.from(key, 'hex');
  const dk = crypto.scryptSync(String(plain), salt, 64);
  return keyBuf.length === dk.length && crypto.timingSafeEqual(keyBuf, dk);
}

// Codigo de emparejamiento legible (sin caracteres ambiguos), unico.
function genPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

// ----------------------- Sentencias preparadas -----------------------

const stmts = {
  // --- Empresas ---
  insertEmpresa: db.prepare(`
    INSERT INTO empresas (id, nombre, pairing_code, activa, created_at)
    VALUES (@id, @nombre, @pairing_code, 1, @created_at)
  `),
  getEmpresa: db.prepare('SELECT * FROM empresas WHERE id = ?'),
  getEmpresaByCode: db.prepare('SELECT * FROM empresas WHERE pairing_code = ?'),
  getEmpresaByNombre: db.prepare('SELECT * FROM empresas WHERE nombre = ? COLLATE NOCASE'),
  listEmpresas: db.prepare('SELECT * FROM empresas ORDER BY nombre COLLATE NOCASE'),
  updateEmpresaCode: db.prepare('UPDATE empresas SET pairing_code = ? WHERE id = ?'),
  updateEmpresaActiva: db.prepare('UPDATE empresas SET activa = ? WHERE id = ?'),

  // --- Usuarios ---
  insertUser: db.prepare(`
    INSERT INTO usuarios (id, empresa_id, usuario, password_hash, rol, activo, created_at)
    VALUES (@id, @empresa_id, @usuario, @password_hash, @rol, 1, @created_at)
  `),
  getUserById: db.prepare('SELECT * FROM usuarios WHERE id = ?'),
  // Login: el nombre de usuario es unico en todo el sistema.
  getUserByUsuario: db.prepare('SELECT * FROM usuarios WHERE usuario = ? COLLATE NOCASE'),
  countSuper: db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'super_admin'"),
  listUsersByEmpresa: db.prepare(
    'SELECT id, empresa_id, usuario, rol, activo, created_at FROM usuarios WHERE empresa_id = ? ORDER BY usuario COLLATE NOCASE'
  ),
  setUserActivo: db.prepare('UPDATE usuarios SET activo = ? WHERE id = ? AND empresa_id = ?'),
  deleteUserStmt: db.prepare('DELETE FROM usuarios WHERE id = ? AND empresa_id = ?'),

  // --- Dispositivos ---
  getDevice: db.prepare('SELECT * FROM dispositivos WHERE id = ?'),

  insertDevice: db.prepare(`
    INSERT INTO dispositivos (id, empresa_id, nombre, ultima_conexion, ip_actual)
    VALUES (@id, @empresa_id, @nombre, @ultima_conexion, @ip_actual)
  `),

  touchDevice: db.prepare(`
    UPDATE dispositivos
       SET ultima_conexion = @ultima_conexion,
           ip_actual       = @ip_actual
     WHERE id = @id
  `),

  renameDevice: db.prepare('UPDATE dispositivos SET nombre = ? WHERE id = ? AND empresa_id = ?'),

  setLayout: db.prepare('UPDATE dispositivos SET layout_json = ? WHERE id = ?'),

  listDevicesByEmpresa: db.prepare(
    'SELECT * FROM dispositivos WHERE empresa_id = ? ORDER BY nombre COLLATE NOCASE'
  ),

  deleteDevice: db.prepare('DELETE FROM dispositivos WHERE id = ? AND empresa_id = ?'),

  // Migracion: dispositivos sin empresa.
  listOrphanDevices: db.prepare('SELECT id FROM dispositivos WHERE empresa_id IS NULL'),
  assignDeviceEmpresa: db.prepare('UPDATE dispositivos SET empresa_id = ? WHERE id = ?'),

  // Migracion: dispositivos sin layout_json (esquema anterior).
  listDevicesNoLayout: db.prepare('SELECT id FROM dispositivos WHERE layout_json IS NULL'),

  // --- Playlists ---
  getPlaylist: db.prepare(`
    SELECT video_url_o_nombre, orden
      FROM playlists
     WHERE dispositivo_id = ?
     ORDER BY orden ASC
  `),
  clearPlaylist: db.prepare('DELETE FROM playlists WHERE dispositivo_id = ?'),

  getImagePlaylist: db.prepare(`
    SELECT imagen, orden
      FROM image_playlists
     WHERE dispositivo_id = ?
     ORDER BY orden ASC
  `),
  clearImagePlaylist: db.prepare('DELETE FROM image_playlists WHERE dispositivo_id = ?'),
};

// ----------------------------- Empresas -----------------------------

/** Crea una empresa con un pairing_code unico. Devuelve el registro creado. */
function createEmpresa(nombre) {
  const clean = String(nombre || '').trim();
  if (!clean) {
    const err = new Error('Nombre de empresa requerido');
    err.code = 'EMPRESA_NOMBRE';
    throw err;
  }
  if (stmts.getEmpresaByNombre.get(clean)) {
    const err = new Error('Ya existe una empresa con ese nombre');
    err.code = 'EMPRESA_DUP';
    throw err;
  }
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  // Reintenta ante una colision (muy improbable) del pairing_code.
  for (let intento = 0; intento < 5; intento++) {
    const pairing_code = genPairingCode();
    try {
      stmts.insertEmpresa.run({ id, nombre: clean, pairing_code, created_at });
      return stmts.getEmpresa.get(id);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('No se pudo generar un pairing_code unico');
}

function listEmpresas() {
  return stmts.listEmpresas.all();
}

function getEmpresa(id) {
  return stmts.getEmpresa.get(id);
}

function getEmpresaByPairingCode(code) {
  if (!code) return null;
  return stmts.getEmpresaByCode.get(String(code).trim().toUpperCase()) || null;
}

function getEmpresaByNombre(nombre) {
  if (!nombre) return null;
  return stmts.getEmpresaByNombre.get(String(nombre).trim()) || null;
}

function rotatePairingCode(empresaId) {
  for (let intento = 0; intento < 5; intento++) {
    const code = genPairingCode();
    try {
      const r = stmts.updateEmpresaCode.run(code, empresaId);
      return r.changes > 0 ? code : null;
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('No se pudo generar un pairing_code unico');
}

function setEmpresaActiva(empresaId, activa) {
  return stmts.updateEmpresaActiva.run(activa ? 1 : 0, empresaId).changes > 0;
}

// ----------------------------- Usuarios -----------------------------

/**
 * Crea un usuario. Para super_admin, empresaId debe ser null.
 * Lanza si el login ya existe en esa empresa (UNIQUE).
 */
function createUser({ empresaId = null, usuario, password, rol }) {
  const id = crypto.randomUUID();
  stmts.insertUser.run({
    id,
    empresa_id: empresaId,
    usuario: String(usuario).trim(),
    password_hash: hashPassword(password),
    rol,
    created_at: new Date().toISOString(),
  });
  return stmts.getUserById.get(id);
}

/**
 * Crea una empresa junto con su admin inicial de forma ATOMICA: si el nombre de
 * usuario del admin ya existe (unico global) o falla cualquier paso, se revierte
 * todo y no queda una empresa sin admin. Devuelve la empresa creada.
 */
const createEmpresaWithAdmin = db.transaction(({ nombre, adminUser, adminPass }) => {
  const empresa = createEmpresa(nombre);
  createUser({ empresaId: empresa.id, usuario: adminUser, password: adminPass, rol: 'admin' });
  return empresa;
});

function getUserById(id) {
  return stmts.getUserById.get(id);
}

/**
 * Busca un usuario por su nombre (unico en todo el sistema) para autenticacion.
 * Devuelve el registro (con empresa_id y rol) o undefined.
 */
function getUserByUsuario(usuario) {
  return stmts.getUserByUsuario.get(String(usuario).trim());
}

function listUsers(empresaId) {
  return stmts.listUsersByEmpresa.all(empresaId);
}

function setUserActivo(empresaId, userId, activo) {
  return stmts.setUserActivo.run(activo ? 1 : 0, userId, empresaId).changes > 0;
}

function deleteUser(empresaId, userId) {
  return stmts.deleteUserStmt.run(userId, empresaId).changes > 0;
}

// ----------------------------- Helpers internos -----------------------------

function getPlaylistArray(deviceId) {
  return stmts.getPlaylist.all(deviceId).map((r) => r.video_url_o_nombre);
}

function getImagePlaylistArray(deviceId) {
  return stmts.getImagePlaylist.all(deviceId).map((r) => r.imagen);
}

// ----------------------------- Layout (zonas + widgets) -----------------------------

/**
 * Devuelve el layout de un dispositivo como objeto. Si la columna esta vacia
 * (dispositivo antiguo aun no migrado), lo deriva de las listas por-dispositivo
 * para no perder contenido. Nunca devuelve null si el dispositivo existe.
 */
function getLayout(deviceId) {
  const dev = stmts.getDevice.get(deviceId);
  if (!dev) return null;
  if (dev.layout_json) {
    try {
      return layouts.validateLayout(JSON.parse(dev.layout_json));
    } catch {
      /* JSON corrupto: cae a la derivacion de abajo */
    }
  }
  return layouts.migrateFromPlaylists(
    getPlaylistArray(deviceId),
    getImagePlaylistArray(deviceId)
  );
}

/**
 * Guarda el layout de un dispositivo (acotado a la empresa). Valida con el
 * catalogo (incluida la regla de <=1 zona con video) y persiste el JSON
 * normalizado. Devuelve el layout guardado, o null si el dispositivo es de otra
 * empresa. Lanza layouts.LayoutError si el layout es invalido.
 */
const saveLayout = db.transaction((empresaId, deviceId, layout) => {
  const dev = ensureDeviceInEmpresa(empresaId, deviceId);
  if (!dev) return null; // dispositivo de otra empresa
  const normalized = layouts.validateLayout(layout);
  stmts.setLayout.run(JSON.stringify(normalized), deviceId);
  return normalized;
});

/** Asegura que el dispositivo exista y pertenezca a la empresa. Devuelve el registro o null. */
function ensureDeviceInEmpresa(empresaId, deviceId) {
  const existing = stmts.getDevice.get(deviceId);
  if (existing) {
    return existing.empresa_id === empresaId ? existing : null; // de otra empresa => null
  }
  stmts.insertDevice.run({
    id: deviceId,
    empresa_id: empresaId,
    nombre: `Dispositivo ${deviceId.slice(0, 8)}`,
    ultima_conexion: null,
    ip_actual: null,
  });
  return stmts.getDevice.get(deviceId);
}

// ----------------------------- Heartbeat (cliente) -----------------------------

/**
 * Registra/actualiza un dispositivo y devuelve sus playlists.
 * - Dispositivo existente: ignora el pairingCode, solo refresca conexion/IP.
 * - Dispositivo nuevo: EXIGE un pairingCode valido de una empresa activa.
 * Devuelve null si el dispositivo es nuevo y no hay emparejamiento valido.
 */
const heartbeat = db.transaction((deviceId, ip, nombreSugerido, pairingCode) => {
  const now = new Date().toISOString();
  const existing = stmts.getDevice.get(deviceId);

  if (existing) {
    stmts.touchDevice.run({ id: deviceId, ultima_conexion: now, ip_actual: ip });
    const layout = getLayout(deviceId);
    const { videos, images } = layouts.flattenMedia(layout);
    return { empresaId: existing.empresa_id, layout, playlist: videos, images };
  }

  // Dispositivo nuevo: requiere emparejamiento.
  const empresa = getEmpresaByPairingCode(pairingCode);
  if (!empresa || !empresa.activa) return null;

  const layout = layouts.defaultLayout();
  stmts.insertDevice.run({
    id: deviceId,
    empresa_id: empresa.id,
    nombre: nombreSugerido || `Dispositivo ${deviceId.slice(0, 8)}`,
    ultima_conexion: now,
    ip_actual: ip,
  });
  stmts.setLayout.run(JSON.stringify(layout), deviceId);

  const { videos, images } = layouts.flattenMedia(layout);
  return { empresaId: empresa.id, layout, playlist: videos, images };
});

// ----------------------------- Dispositivos (admin) -----------------------------

/** Lista de dispositivos de una empresa con estado online/offline y sus playlists. */
function listDevicesWithStatus(empresaId, onlineWindowMin) {
  const limitMs = onlineWindowMin * 60 * 1000;
  const now = Date.now();

  return stmts.listDevicesByEmpresa.all(empresaId).map((d) => {
    const lastMs = d.ultima_conexion ? new Date(d.ultima_conexion).getTime() : 0;
    const online = lastMs > 0 && now - lastMs <= limitMs;
    return {
      id: d.id,
      nombre: d.nombre,
      ip_actual: d.ip_actual,
      ultima_conexion: d.ultima_conexion,
      online,
      layout: getLayout(d.id),
    };
  });
}

const deleteDevice = db.transaction((empresaId, deviceId) => {
  const dev = stmts.getDevice.get(deviceId);
  if (!dev || dev.empresa_id !== empresaId) return false;
  stmts.clearPlaylist.run(deviceId);
  stmts.clearImagePlaylist.run(deviceId);
  return stmts.deleteDevice.run(deviceId, empresaId).changes > 0;
});

/** Crea un dispositivo vacio bajo la empresa (alta manual desde el panel). */
function createDevice(empresaId, deviceId, nombre) {
  const dev = ensureDeviceInEmpresa(empresaId, deviceId);
  if (!dev) return false;
  if (nombre) stmts.renameDevice.run(String(nombre).trim(), deviceId, empresaId);
  return true;
}

/** Devuelve la empresa_id de un dispositivo (para acotar descargas), o null. */
function getDeviceEmpresaId(deviceId) {
  const dev = stmts.getDevice.get(deviceId);
  return dev ? dev.empresa_id : null;
}

// ----------------------------- Medios (uso en layouts) -----------------------------

/**
 * Busca en que dispositivos de la empresa se usa un archivo de medio.
 * `kind` es 'video' | 'image'. Devuelve [{ id, nombre }] (sin duplicados),
 * que es justo lo que necesita la opcion "bloquear borrado si esta en uso".
 */
function findMediaUsage(empresaId, kind, filename) {
  const target = String(filename || '').trim();
  if (!target) return [];
  const usados = [];
  for (const d of stmts.listDevicesByEmpresa.all(empresaId)) {
    const { videos, images } = layouts.flattenMedia(getLayout(d.id));
    const list = kind === 'image' ? images : videos;
    if (list.includes(target)) usados.push({ id: d.id, nombre: d.nombre });
  }
  return usados;
}

// ----------------------------- Seed / Migracion de datos -----------------------------

/**
 * Asegura el super-admin y, si corresponde, migra la data existente a una
 * empresa "Default". Idempotente: se ejecuta en cada arranque.
 *
 * Devuelve { defaultEmpresaId } con la empresa que recibio los dispositivos
 * huerfanos (o null si no hubo migracion de medios que hacer).
 */
const ensureSeed = db.transaction((opts) => {
  const {
    superUser,
    superPass,
    defaultAdminUser,
    defaultAdminPass,
    defaultEmpresaNombre = 'Default',
  } = opts;

  // 1) Super-admin global (si no existe ninguno).
  if (stmts.countSuper.get().n === 0) {
    createUser({ empresaId: null, usuario: superUser, password: superPass, rol: 'super_admin' });
  }

  // 2) Migracion: dispositivos huerfanos (BD antigua) o BD sin empresas.
  const orphans = stmts.listOrphanDevices.all();
  const sinEmpresas = stmts.listEmpresas.all().length === 0;

  let defaultEmpresaId = null;
  if (orphans.length > 0 || sinEmpresas) {
    const empresa = createEmpresa(defaultEmpresaNombre);
    defaultEmpresaId = empresa.id;

    // Asigna todos los dispositivos huerfanos a la empresa Default.
    orphans.forEach((d) => stmts.assignDeviceEmpresa.run(empresa.id, d.id));

    // Crea el admin de la empresa Default (reusa credenciales antiguas).
    createUser({
      empresaId: empresa.id,
      usuario: defaultAdminUser,
      password: defaultAdminPass,
      rol: 'admin',
    });
  }

  // 3) Migracion: dispositivos sin layout -> deriva preset "cuatro" de sus listas.
  for (const { id } of stmts.listDevicesNoLayout.all()) {
    const layout = layouts.migrateFromPlaylists(
      getPlaylistArray(id),
      getImagePlaylistArray(id)
    );
    stmts.setLayout.run(JSON.stringify(layout), id);
  }

  return { defaultEmpresaId };
});

module.exports = {
  db,
  // hashing
  hashPassword,
  verifyPassword,
  // empresas
  createEmpresa,
  listEmpresas,
  getEmpresa,
  getEmpresaByPairingCode,
  getEmpresaByNombre,
  rotatePairingCode,
  setEmpresaActiva,
  createEmpresaWithAdmin,
  // usuarios
  createUser,
  getUserById,
  getUserByUsuario,
  listUsers,
  setUserActivo,
  deleteUser,
  // dispositivos / playlists (acotados por empresa)
  heartbeat,
  getPlaylistArray,
  getImagePlaylistArray,
  // layout (zonas + widgets)
  getLayout,
  saveLayout,
  layouts,
  listDevicesWithStatus,
  deleteDevice,
  createDevice,
  getDeviceEmpresaId,
  // medios
  findMediaUsage,
  // seed / migracion
  ensureSeed,
};
