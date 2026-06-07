'use strict';

/**
 * ============================================================================
 *  DigiSignage - Servidor Admin Central
 * ============================================================================
 *  - API REST (Express) + SQLite (better-sqlite3)
 *  - Autenticacion del panel via JWT en cookie httpOnly
 *  - Sirve el frontend del administrador (login / dashboard)
 *  - Sirve los videos para que los clientes los descarguen
 * ============================================================================
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const dataLayer = require('./db');

// ----------------------------- Configuracion -----------------------------

const PORT = parseInt(process.env.PORT || '4000', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_inseguro';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const ONLINE_WINDOW_MIN = parseInt(process.env.ONLINE_WINDOW_MIN || '3', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '500', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const MEDIA_DIR = path.join(__dirname, 'media');
const IMAGES_DIR = path.join(__dirname, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Carpetas de medios: videos maestros e imagenes del slider que se distribuyen.
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ----------------------------- Autenticacion -----------------------------

const COOKIE_NAME = 'ds_token';

function signToken(user) {
  return jwt.sign({ sub: user, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/** Middleware: exige un JWT valido en la cookie para rutas /api/admin/*. */
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesion invalida o expirada' });
  }
}

// POST /api/login -> valida credenciales fijas y entrega cookie de sesion.
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body || {};
  if (usuario === ADMIN_USER && password === ADMIN_PASS) {
    const token = signToken(usuario);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.json({ ok: true, usuario });
  }
  res.status(401).json({ error: 'Credenciales invalidas' });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// GET /api/me -> usado por el frontend para saber si la sesion sigue viva.
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ usuario: req.user.sub });
});

// ----------------------------- API de cliente -----------------------------

/** Obtiene la IP real del cliente respetando proxies inversos. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

/**
 * POST /api/heartbeat
 * Body: { deviceId: string, nombre?: string }
 * - Registra/actualiza el dispositivo (ultima_conexion + ip).
 * - Devuelve la playlist ordenada actual.
 */
app.post('/api/heartbeat', (req, res) => {
  const { deviceId, nombre } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'deviceId requerido' });
  }
  const ip = clientIp(req);
  const { playlist, images } = dataLayer.heartbeat(deviceId, ip, nombre);
  res.json({
    ok: true,
    deviceId,
    serverTime: new Date().toISOString(),
    playlist,
    images,
  });
});

/**
 * GET /download/:filename
 * Descarga de un video maestro desde la carpeta media/.
 * Usado por el cliente cuando le falta un archivo localmente.
 */
app.get('/download/:filename', (req, res) => {
  const safe = path.basename(req.params.filename); // evita path traversal
  const filePath = path.join(MEDIA_DIR, safe);
  if (!filePath.startsWith(MEDIA_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.download(filePath, safe);
});

/**
 * GET /image/:filename
 * Descarga de una imagen del slider desde la carpeta images/.
 */
app.get('/image/:filename', (req, res) => {
  const safe = path.basename(req.params.filename); // evita path traversal
  const filePath = path.join(IMAGES_DIR, safe);
  if (!filePath.startsWith(IMAGES_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Imagen no encontrada' });
  }
  res.download(filePath, safe);
});

// ----------------------------- API de admin -----------------------------

// GET /api/admin/devices -> lista con estado online/offline y playlist.
app.get('/api/admin/devices', requireAuth, (req, res) => {
  res.json({ devices: dataLayer.listDevicesWithStatus(ONLINE_WINDOW_MIN) });
});

/**
 * POST /api/admin/playlist
 * Body: { deviceId: string, videos: string[] }
 * Reemplaza el orden completo de la playlist del dispositivo.
 */
app.post('/api/admin/playlist', requireAuth, (req, res) => {
  const { deviceId, videos } = req.body || {};
  if (!deviceId || !Array.isArray(videos)) {
    return res.status(400).json({ error: 'deviceId y videos[] requeridos' });
  }
  const limpio = videos.map((v) => String(v).trim()).filter(Boolean);
  const playlist = dataLayer.savePlaylist(deviceId, limpio);
  res.json({ ok: true, deviceId, playlist });
});

/**
 * POST /api/admin/imageplaylist
 * Body: { deviceId: string, images: string[] }
 * Reemplaza el orden completo de la playlist de imagenes del dispositivo.
 */
app.post('/api/admin/imageplaylist', requireAuth, (req, res) => {
  const { deviceId, images } = req.body || {};
  if (!deviceId || !Array.isArray(images)) {
    return res.status(400).json({ error: 'deviceId e images[] requeridos' });
  }
  const limpio = images.map((v) => String(v).trim()).filter(Boolean);
  const imagePlaylist = dataLayer.saveImagePlaylist(deviceId, limpio);
  res.json({ ok: true, deviceId, images: imagePlaylist });
});

// POST /api/admin/device -> alta/renombrado manual de un dispositivo.
app.post('/api/admin/device', requireAuth, (req, res) => {
  const { deviceId, nombre } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId requerido' });
  if (!dataLayer.deviceExists(deviceId)) {
    // Crea el registro vacio (sin playlist) reutilizando savePlaylist.
    dataLayer.savePlaylist(deviceId, []);
  }
  if (nombre) dataLayer.renameDevice(deviceId, String(nombre).trim());
  res.json({ ok: true });
});

// DELETE /api/admin/device/:id
app.delete('/api/admin/device/:id', requireAuth, (req, res) => {
  const ok = dataLayer.deleteDevice(req.params.id);
  res.json({ ok });
});

// GET /api/admin/media -> lista de videos + limite de subida (para el frontend).
app.get('/api/admin/media', requireAuth, (req, res) => {
  const files = fs
    .readdirSync(MEDIA_DIR)
    .filter((f) => /\.(mp4|webm|ogg|mov|mkv)$/i.test(f))
    .sort();
  res.json({ media: files, maxUploadMB: MAX_UPLOAD_MB });
});

// POST /api/admin/media -> subir un nuevo video al servidor (limite configurable).
const upload = multer({ dest: MEDIA_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });
app.post('/api/admin/media', requireAuth, (req, res) => {
  // upload.single como callback para capturar el error de tamaño con un mensaje claro.
  upload.single('video')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(413)
          .json({ error: `El archivo supera el límite de ${MAX_UPLOAD_MB} MB` });
      }
      return res.status(400).json({ error: err.message || 'Error al subir' });
    }
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const safe = path.basename(req.file.originalname);
    const dest = path.join(MEDIA_DIR, safe);
    fs.renameSync(req.file.path, dest); // conserva el nombre original
    res.json({ ok: true, filename: safe });
  });
});

// GET /api/admin/images -> lista de imagenes del slider + limite de subida.
app.get('/api/admin/images', requireAuth, (req, res) => {
  const files = fs
    .readdirSync(IMAGES_DIR)
    .filter((f) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f))
    .sort();
  res.json({ images: files, maxUploadMB: MAX_UPLOAD_MB });
});

// POST /api/admin/images -> subir una nueva imagen al servidor.
const uploadImg = multer({ dest: IMAGES_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });
app.post('/api/admin/images', requireAuth, (req, res) => {
  uploadImg.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(413)
          .json({ error: `El archivo supera el límite de ${MAX_UPLOAD_MB} MB` });
      }
      return res.status(400).json({ error: err.message || 'Error al subir' });
    }
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const safe = path.basename(req.file.originalname);
    const dest = path.join(IMAGES_DIR, safe);
    fs.renameSync(req.file.path, dest); // conserva el nombre original
    res.json({ ok: true, filename: safe });
  });
});

// ----------------------------- Frontend admin -----------------------------

app.use(express.static(PUBLIC_DIR));

// Raiz -> login.
app.get('/', (req, res) => res.redirect('/login.html'));

// ----------------------------- Arranque -----------------------------

app.listen(PORT, () => {
  console.log('============================================');
  console.log('  DigiSignage Admin Central');
  console.log(`  Escuchando en  http://localhost:${PORT}`);
  console.log(`  Panel:         http://localhost:${PORT}/login.html`);
  console.log(`  Media dir:     ${MEDIA_DIR}`);
  console.log('============================================');
});
