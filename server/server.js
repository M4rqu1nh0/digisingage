'use strict';

/**
 * ============================================================================
 *  DigiSignage - Servidor Admin Central (MULTI-TENANT)
 * ============================================================================
 *  - API REST (Express) + SQLite (better-sqlite3)
 *  - Multi-empresa: cada empresa administra de forma privada sus pantallas,
 *    medios y usuarios. El aislamiento se aplica por empresa_id.
 *  - Roles: super_admin (global) / admin (empresa) / operador (empresa)
 *  - Autenticacion via JWT en cookie httpOnly
 *  - Las pantallas se vinculan a una empresa con un "pairing code"
 *  - Sirve el frontend del administrador y los medios para los clientes
 * ============================================================================
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const dataLayer = require('./db');

// ----------------------------- Configuracion -----------------------------

const PORT = parseInt(process.env.PORT || '4000', 10);

// Credenciales del super-admin global (se crean en el primer arranque).
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || 'superadmin';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'superadmin123';

// Credenciales del admin de la empresa "Default" (migracion de datos antiguos).
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_inseguro';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const ONLINE_WINDOW_MIN = parseInt(process.env.ONLINE_WINDOW_MIN || '3', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '500', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Carpetas configurables (util para tests y disco persistente en Render).
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const VIDEO_RE = /\.(mp4|webm|ogg|mov|mkv)$/i;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

// Carpetas de medios POR EMPRESA: media/<empresaId>/ e images/<empresaId>/.
function empresaMediaDir(empresaId) {
  const dir = path.join(MEDIA_DIR, empresaId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function empresaImagesDir(empresaId) {
  const dir = path.join(IMAGES_DIR, empresaId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ----------------------------- Arranque: seed + migracion -----------------------------

// Crea el super-admin y, si hay datos antiguos, los migra a una empresa "Default".
const seed = dataLayer.ensureSeed({
  superUser: SUPERADMIN_USER,
  superPass: SUPERADMIN_PASS,
  defaultAdminUser: ADMIN_USER,
  defaultAdminPass: ADMIN_PASS,
});

// Mueve medios "sueltos" (esquema antiguo) a la carpeta de la empresa Default.
function migrateLooseMedia(defaultEmpresaId) {
  if (!defaultEmpresaId) return;
  const jobs = [
    { base: MEDIA_DIR, dirFor: empresaMediaDir, re: VIDEO_RE },
    { base: IMAGES_DIR, dirFor: empresaImagesDir, re: IMAGE_RE },
  ];
  let moved = 0;
  for (const { base, dirFor, re } of jobs) {
    const target = dirFor(defaultEmpresaId);
    for (const name of fs.readdirSync(base)) {
      if (!re.test(name)) continue;
      const full = path.join(base, name);
      try {
        if (fs.statSync(full).isFile()) {
          fs.renameSync(full, path.join(target, name));
          moved++;
        }
      } catch {
        /* ignora archivos que no se puedan mover */
      }
    }
  }
  if (moved) console.log(`  Migrados ${moved} archivo(s) de medios a la empresa Default`);
}
migrateLooseMedia(seed.defaultEmpresaId);

// ----------------------------- Autenticacion -----------------------------

const COOKIE_NAME = 'ds_token';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, empresaId: user.empresa_id, rol: user.rol },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

/** Verifica el JWT y carga el usuario fresco de la BD (respeta bajas/cambios de rol). */
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesion invalida o expirada' });
  }
  const user = dataLayer.getUserById(payload.sub);
  if (!user || !user.activo) return res.status(401).json({ error: 'Sesion invalida' });
  req.user = { id: user.id, usuario: user.usuario, empresaId: user.empresa_id, rol: user.rol };
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user.rol !== 'super_admin') return res.status(403).json({ error: 'Requiere super-admin' });
  next();
}

/** Usuario de empresa (admin u operador) con empresa asignada. */
function requireEmpresaUser(req, res, next) {
  if (req.user.empresaId && (req.user.rol === 'admin' || req.user.rol === 'operador')) return next();
  return res.status(403).json({ error: 'No autorizado' });
}

/** Solo admin de empresa (gestion de usuarios). */
function requireEmpresaAdmin(req, res, next) {
  if (req.user.empresaId && req.user.rol === 'admin') return next();
  return res.status(403).json({ error: 'Requiere admin de empresa' });
}

// POST /api/login -> { usuario, password, empresa? }
//  - Sin "empresa": intento de super-admin.
//  - Con "empresa" (nombre): usuario de esa empresa.
app.post('/api/login', (req, res) => {
  const { usuario, password, empresa } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  let user = null;
  if (empresa && String(empresa).trim()) {
    const emp = dataLayer.getEmpresaByNombre(String(empresa).trim());
    if (!emp || !emp.activa) return res.status(401).json({ error: 'Credenciales invalidas' });
    user = dataLayer.getUserByLogin(emp.id, usuario);
  } else {
    user = dataLayer.getSuperAdminByLogin(usuario);
  }

  if (!user || !user.activo || !dataLayer.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales invalidas' });
  }

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ ok: true, usuario: user.usuario, rol: user.rol });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// GET /api/me -> identidad de la sesion (para redirigir y mostrar contexto).
app.get('/api/me', requireAuth, (req, res) => {
  let empresaNombre = null;
  if (req.user.empresaId) {
    const emp = dataLayer.getEmpresa(req.user.empresaId);
    empresaNombre = emp ? emp.nombre : null;
  }
  res.json({
    usuario: req.user.usuario,
    rol: req.user.rol,
    empresaId: req.user.empresaId,
    empresaNombre,
  });
});

// ----------------------------- API de cliente (pantallas) -----------------------------

/** Obtiene la IP real del cliente respetando proxies inversos. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

/**
 * POST /api/heartbeat
 * Body: { deviceId, nombre?, pairingCode? }
 * - Dispositivo existente: refresca conexion/IP y devuelve su playlist.
 * - Dispositivo nuevo: requiere pairingCode valido de una empresa activa.
 */
app.post('/api/heartbeat', (req, res) => {
  const { deviceId, nombre, pairingCode } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'deviceId requerido' });
  }
  const ip = clientIp(req);
  const result = dataLayer.heartbeat(deviceId, ip, nombre, pairingCode);
  if (!result) {
    return res.status(403).json({ error: 'Dispositivo no emparejado. Falta un pairing code valido.' });
  }
  res.json({
    ok: true,
    deviceId,
    serverTime: new Date().toISOString(),
    playlist: result.playlist,
    images: result.images,
  });
});

/** Resuelve la empresa de un dispositivo desde la query/header (descargas privadas). */
function empresaFromDevice(req) {
  const deviceId = String(req.query.deviceId || req.headers['x-device-id'] || '').trim();
  if (!deviceId) return null;
  return dataLayer.getDeviceEmpresaId(deviceId);
}

// GET /download/:filename?deviceId=... -> video de la empresa del dispositivo.
app.get('/download/:filename', (req, res) => {
  const empresaId = empresaFromDevice(req);
  if (!empresaId) return res.status(404).json({ error: 'No encontrado' });
  const dir = empresaMediaDir(empresaId);
  const safe = path.basename(req.params.filename);
  const filePath = path.join(dir, safe);
  if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.download(filePath, safe);
});

// GET /image/:filename?deviceId=... -> imagen del slider de la empresa del dispositivo.
app.get('/image/:filename', (req, res) => {
  const empresaId = empresaFromDevice(req);
  if (!empresaId) return res.status(404).json({ error: 'No encontrado' });
  const dir = empresaImagesDir(empresaId);
  const safe = path.basename(req.params.filename);
  const filePath = path.join(dir, safe);
  if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Imagen no encontrada' });
  }
  res.download(filePath, safe);
});

// ----------------------------- API de super-admin -----------------------------

// GET /api/super/empresas -> empresas con conteo de dispositivos.
app.get('/api/super/empresas', requireAuth, requireSuperAdmin, (req, res) => {
  const countStmt = dataLayer.db.prepare(
    'SELECT COUNT(*) AS n FROM dispositivos WHERE empresa_id = ?'
  );
  const empresas = dataLayer.listEmpresas().map((e) => ({
    id: e.id,
    nombre: e.nombre,
    pairing_code: e.pairing_code,
    activa: !!e.activa,
    created_at: e.created_at,
    dispositivos: countStmt.get(e.id).n,
  }));
  res.json({ empresas });
});

// POST /api/super/empresas -> crea empresa + su admin inicial.
app.post('/api/super/empresas', requireAuth, requireSuperAdmin, (req, res) => {
  const { nombre, adminUser, adminPass } = req.body || {};
  if (!nombre || !adminUser || !adminPass) {
    return res.status(400).json({ error: 'nombre, adminUser y adminPass requeridos' });
  }
  let empresa;
  try {
    empresa = dataLayer.createEmpresa(nombre);
  } catch (e) {
    if (e.code === 'EMPRESA_DUP') return res.status(409).json({ error: e.message });
    if (e.code === 'EMPRESA_NOMBRE') return res.status(400).json({ error: e.message });
    throw e;
  }
  try {
    dataLayer.createUser({
      empresaId: empresa.id,
      usuario: adminUser,
      password: adminPass,
      rol: 'admin',
    });
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo crear el admin: ' + e.message });
  }
  // Prepara las carpetas de medios de la empresa.
  empresaMediaDir(empresa.id);
  empresaImagesDir(empresa.id);

  res.json({
    ok: true,
    empresa: {
      id: empresa.id,
      nombre: empresa.nombre,
      pairing_code: empresa.pairing_code,
      activa: !!empresa.activa,
    },
  });
});

// POST /api/super/empresas/:id/rotate-code -> regenera el pairing code.
app.post('/api/super/empresas/:id/rotate-code', requireAuth, requireSuperAdmin, (req, res) => {
  const code = dataLayer.rotatePairingCode(req.params.id);
  if (!code) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ ok: true, pairing_code: code });
});

// PATCH /api/super/empresas/:id -> activar/desactivar empresa.
app.patch('/api/super/empresas/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const { activa } = req.body || {};
  if (typeof activa !== 'boolean') return res.status(400).json({ error: 'activa (boolean) requerido' });
  const ok = dataLayer.setEmpresaActiva(req.params.id, activa);
  if (!ok) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ ok: true });
});

// ----------------------------- API de admin (empresa) -----------------------------

// GET /api/admin/empresa -> datos de la empresa del usuario (incluye pairing code).
app.get('/api/admin/empresa', requireAuth, requireEmpresaUser, (req, res) => {
  const emp = dataLayer.getEmpresa(req.user.empresaId);
  if (!emp) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({
    id: emp.id,
    nombre: emp.nombre,
    pairing_code: emp.pairing_code,
    activa: !!emp.activa,
    rol: req.user.rol,
  });
});

// GET /api/admin/devices -> dispositivos de la empresa con estado y playlists.
app.get('/api/admin/devices', requireAuth, requireEmpresaUser, (req, res) => {
  res.json({ devices: dataLayer.listDevicesWithStatus(req.user.empresaId, ONLINE_WINDOW_MIN) });
});

// POST /api/admin/playlist -> reemplaza la playlist de video de un dispositivo.
app.post('/api/admin/playlist', requireAuth, requireEmpresaUser, (req, res) => {
  const { deviceId, videos } = req.body || {};
  if (!deviceId || !Array.isArray(videos)) {
    return res.status(400).json({ error: 'deviceId y videos[] requeridos' });
  }
  const limpio = videos.map((v) => String(v).trim()).filter(Boolean);
  const playlist = dataLayer.savePlaylist(req.user.empresaId, deviceId, limpio);
  if (playlist === null) return res.status(404).json({ error: 'Dispositivo no encontrado en tu empresa' });
  res.json({ ok: true, deviceId, playlist });
});

// POST /api/admin/imageplaylist -> reemplaza la playlist de imagenes.
app.post('/api/admin/imageplaylist', requireAuth, requireEmpresaUser, (req, res) => {
  const { deviceId, images } = req.body || {};
  if (!deviceId || !Array.isArray(images)) {
    return res.status(400).json({ error: 'deviceId e images[] requeridos' });
  }
  const limpio = images.map((v) => String(v).trim()).filter(Boolean);
  const imagePlaylist = dataLayer.saveImagePlaylist(req.user.empresaId, deviceId, limpio);
  if (imagePlaylist === null) return res.status(404).json({ error: 'Dispositivo no encontrado en tu empresa' });
  res.json({ ok: true, deviceId, images: imagePlaylist });
});

// POST /api/admin/device -> alta/renombrado manual de un dispositivo.
app.post('/api/admin/device', requireAuth, requireEmpresaUser, (req, res) => {
  const { deviceId, nombre } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId requerido' });
  const ok = dataLayer.createDevice(req.user.empresaId, String(deviceId).trim(), nombre);
  if (!ok) return res.status(409).json({ error: 'Ese dispositivo ya pertenece a otra empresa' });
  res.json({ ok: true });
});

// DELETE /api/admin/device/:id
app.delete('/api/admin/device/:id', requireAuth, requireEmpresaUser, (req, res) => {
  const ok = dataLayer.deleteDevice(req.user.empresaId, req.params.id);
  res.json({ ok });
});

// GET /api/admin/media -> videos de la empresa + limite de subida.
app.get('/api/admin/media', requireAuth, requireEmpresaUser, (req, res) => {
  const dir = empresaMediaDir(req.user.empresaId);
  const files = fs.readdirSync(dir).filter((f) => VIDEO_RE.test(f)).sort();
  res.json({ media: files, maxUploadMB: MAX_UPLOAD_MB });
});

// GET /api/admin/images -> imagenes de la empresa + limite de subida.
app.get('/api/admin/images', requireAuth, requireEmpresaUser, (req, res) => {
  const dir = empresaImagesDir(req.user.empresaId);
  const files = fs.readdirSync(dir).filter((f) => IMAGE_RE.test(f)).sort();
  res.json({ images: files, maxUploadMB: MAX_UPLOAD_MB });
});

// Multer con destino dinamico por empresa (preserva el nombre original).
function makeUploader(dirFor) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          cb(null, dirFor(req.user.empresaId));
        } catch (e) {
          cb(e);
        }
      },
      filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });
}
const uploadVideo = makeUploader(empresaMediaDir);
const uploadImg = makeUploader(empresaImagesDir);

function handleUpload(uploader, field) {
  return (req, res) => {
    uploader.single(field)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `El archivo supera el límite de ${MAX_UPLOAD_MB} MB` });
        }
        return res.status(400).json({ error: err.message || 'Error al subir' });
      }
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
      res.json({ ok: true, filename: req.file.filename });
    });
  };
}

// POST /api/admin/media -> subir video a la carpeta de la empresa.
app.post('/api/admin/media', requireAuth, requireEmpresaUser, handleUpload(uploadVideo, 'video'));

// POST /api/admin/images -> subir imagen a la carpeta de la empresa.
app.post('/api/admin/images', requireAuth, requireEmpresaUser, handleUpload(uploadImg, 'image'));

// ----------------------------- Gestion de usuarios (admin de empresa) -----------------------------

// GET /api/admin/users -> usuarios de la empresa.
app.get('/api/admin/users', requireAuth, requireEmpresaAdmin, (req, res) => {
  const users = dataLayer.listUsers(req.user.empresaId).map((u) => ({
    id: u.id,
    usuario: u.usuario,
    rol: u.rol,
    activo: !!u.activo,
    created_at: u.created_at,
  }));
  res.json({ users });
});

// POST /api/admin/users -> crea usuario (admin u operador) en la empresa.
app.post('/api/admin/users', requireAuth, requireEmpresaAdmin, (req, res) => {
  const { usuario, password, rol } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ error: 'usuario y password requeridos' });
  const rolFinal = rol === 'admin' ? 'admin' : 'operador';
  try {
    const u = dataLayer.createUser({
      empresaId: req.user.empresaId,
      usuario,
      password,
      rol: rolFinal,
    });
    res.json({ ok: true, user: { id: u.id, usuario: u.usuario, rol: u.rol } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese nombre en la empresa' });
    }
    throw e;
  }
});

// PATCH /api/admin/users/:id -> activar/desactivar (no a uno mismo).
app.patch('/api/admin/users/:id', requireAuth, requireEmpresaAdmin, (req, res) => {
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo (boolean) requerido' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });
  const ok = dataLayer.setUserActivo(req.user.empresaId, req.params.id, activo);
  if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id -> eliminar (no a uno mismo).
app.delete('/api/admin/users/:id', requireAuth, requireEmpresaAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  const ok = dataLayer.deleteUser(req.user.empresaId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ ok: true });
});

// ----------------------------- Frontend -----------------------------

app.use(express.static(PUBLIC_DIR));

// Raiz -> login.
app.get('/', (req, res) => res.redirect('/login.html'));

// ----------------------------- Arranque -----------------------------

app.listen(PORT, () => {
  console.log('============================================');
  console.log('  DigiSignage Admin Central (multi-tenant)');
  console.log(`  Escuchando en  http://localhost:${PORT}`);
  console.log(`  Login:         http://localhost:${PORT}/login.html`);
  console.log(`  Super-admin:   usuario "${SUPERADMIN_USER}"`);
  console.log(`  Media dir:     ${MEDIA_DIR}`);
  console.log('============================================');
});
