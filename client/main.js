'use strict';

/**
 * ============================================================================
 *  DigiSignage - Cliente standalone (Electron)
 * ============================================================================
 *  Un único paquete que incluye Chromium (reproductor) y Node (sincronizacion),
 *  por lo que el equipo destino NO necesita instalar Node, npm ni Chrome.
 *
 *  Proceso principal (este archivo):
 *    - Crea la ventana en modo kiosko a pantalla completa (player.html).
 *    - Registra el protocolo media:// para servir los videos locales.
 *    - Cada N segundos hace heartbeat al servidor, descarga los videos que
 *      falten, borra los sobrantes y envia la playlist al reproductor por IPC.
 *
 *  Datos (portable): se guardan en una carpeta "data" junto al ejecutable.
 * ============================================================================
 */

const { app, BrowserWindow, protocol, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, pathToFileURL } = require('url');

// El audio debe reproducirse sin interaccion del usuario (cartel desatendido).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// El esquema media:// se trata como estandar y con soporte de streaming para
// que el <video> pueda hacer "seek" (peticiones por rango) sobre el archivo.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  { scheme: 'img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

// ----------------------------- Rutas (portable) -----------------------------

// Empaquetado: junto al .exe. En desarrollo: junto a este archivo.
const BASE_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// ----------------------------- Configuracion -----------------------------

/**
 * Crea la carpeta de datos y el config.json (desde la plantilla empaquetada)
 * en el primer arranque, y autogenera un deviceId unico si no existe.
 */
function loadConfig() {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    let tpl = {};
    try {
      tpl = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.template.json'), 'utf8'));
    } catch { /* plantilla ausente: se parte de objeto vacio */ }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(tpl, null, 2));
  }

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

  // deviceId estable y unico por equipo (clave para diferenciar dispositivos).
  if (!cfg.deviceId) {
    cfg.deviceId = crypto.randomUUID();
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
  }

  return {
    serverUrl: (cfg.serverUrl || 'http://localhost:4000').trim().replace(/\/$/, ''),
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName || os.hostname(),
    // Codigo de emparejamiento de la empresa (multi-tenant): se envia en el
    // primer heartbeat para vincular esta pantalla a su empresa.
    pairingCode: String(cfg.pairingCode || '').trim(),
    heartbeatSeconds: Number(cfg.heartbeatSeconds) || 60,
    imageSeconds: Number(cfg.imageSeconds) || 6,
    weather: (cfg.weather && typeof cfg.weather === 'object')
      ? cfg.weather
      : { lat: null, lon: null, city: '' },
  };
}

const config = loadConfig();

function log(...args) { console.log(new Date().toISOString(), ...args); }

log('============================================');
log('  DigiSignage Client (Electron)');
log('  deviceId :', config.deviceId);
log('  server   :', config.serverUrl);
log('  datos    :', DATA_DIR);
log('============================================');

// ----------------------------- Red (sin axios) -----------------------------

/** POST JSON y devuelve el cuerpo parseado. Usa https/http segun la URL. */
function postJson(urlStr, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(bodyObj));
    const req = lib.request(
      u,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { reject(new Error('Respuesta JSON invalida')); }
          } else reject(new Error('HTTP ' + res.statusCode));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** GET JSON y devuelve el cuerpo parseado. */
function getJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON invalido')); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Descarga (con soporte de redirecciones) a un .part y renombra al terminar. */
function downloadTo(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const attempt = (current, redirects) => {
      const u = new URL(current);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error('demasiadas redirecciones'));
          return attempt(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const tmp = destPath + '.part';
        const ws = fs.createWriteStream(tmp);
        res.pipe(ws);
        ws.on('finish', () => ws.close(() => {
          try { fs.renameSync(tmp, destPath); resolve(); } catch (e) { reject(e); }
        }));
        ws.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    attempt(urlStr, 0);
  });
}

// ----------------------------- Sincronizacion -----------------------------

const VIDEO_RE = /\.(mp4|webm|ogg|mov|mkv)$/i;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

function localFiles(dir, re) {
  try { return fs.readdirSync(dir).filter((f) => re.test(f)); } catch { return []; }
}

function nameFrom(item) {
  return /^https?:\/\//i.test(item) ? path.basename(new URL(item).pathname) : item;
}

/**
 * Sincroniza una carpeta local con una lista de medios (videos o imagenes):
 * descarga los que falten, borra los sobrantes. Devuelve los nombres
 * realmente disponibles, en el orden de la lista (respeta repeticiones).
 */
async function syncMedia(items, dir, re, urlFor) {
  const desired = items.map(nameFrom);
  const present = new Set(localFiles(dir, re));

  for (const item of items) {
    const filename = nameFrom(item);
    if (!present.has(filename)) {
      const url = /^https?:\/\//i.test(item) ? item : urlFor(item);
      try {
        log('[download] Bajando', filename);
        await downloadTo(url, path.join(dir, filename));
        present.add(filename);
      } catch (e) {
        log('[download] ERROR con', filename, '-', e.message);
      }
    }
  }

  const desiredSet = new Set(desired);
  for (const file of localFiles(dir, re)) {
    if (!desiredSet.has(file)) {
      try { fs.unlinkSync(path.join(dir, file)); log('[cleanup] Borrado', file); }
      catch (e) { log('[cleanup] No se pudo borrar', file, '-', e.message); }
    }
  }

  const finalAvailable = localFiles(dir, re);
  return desired.filter((f) => finalAvailable.includes(f));
}

let lastPlaylist = []; // ultima lista de videos disponible
let lastImages = [];   // ultima lista de imagenes disponible

async function tick() {
  try {
    const res = await postJson(
      `${config.serverUrl}/api/heartbeat`,
      { deviceId: config.deviceId, nombre: config.deviceName, pairingCode: config.pairingCode },
      15000
    );
    const playlist = Array.isArray(res.playlist) ? res.playlist : [];
    const images = Array.isArray(res.images) ? res.images : [];

    // Una lista vacia se trata como "sin actualizacion": NO se borra el
    // contenido local (protege ante reinicios del servidor / respuestas vacias).
    if (playlist.length === 0) {
      log('[heartbeat] OK · videos vacios -> se conserva lo local');
    } else {
      log('[heartbeat] OK · videos:', JSON.stringify(playlist));
      lastPlaylist = await syncMedia(playlist, VIDEOS_DIR, VIDEO_RE,
        (n) => `${config.serverUrl}/download/${encodeURIComponent(n)}?deviceId=${encodeURIComponent(config.deviceId)}`);
      sendChannel('playlist', lastPlaylist);
      log('[sync] Videos disponibles:', JSON.stringify(lastPlaylist));
    }

    if (images.length === 0) {
      log('[heartbeat] OK · imagenes vacias -> se conserva lo local');
    } else {
      lastImages = await syncMedia(images, IMAGES_DIR, IMAGE_RE,
        (n) => `${config.serverUrl}/image/${encodeURIComponent(n)}?deviceId=${encodeURIComponent(config.deviceId)}`);
      sendChannel('images', lastImages);
      log('[sync] Imagenes disponibles:', JSON.stringify(lastImages));
    }
  } catch (e) {
    log('[heartbeat] FALLO -', e.message, '(se conserva el contenido local)');
  }
}

// ----------------------------- Clima (Open-Meteo) -----------------------------

let resolvedCoords = null; // { lat, lon, city } una vez resuelta la ubicacion
let lastWeather = null;    // ultimo clima enviado al reproductor

/**
 * Resuelve lat/lon: usa las coordenadas del config si existen; si no, geocodifica
 * el nombre de la ciudad con la API de Open-Meteo (sin clave). Si el config trae
 * "Ciudad, Pais" usa el pais para desambiguar.
 */
async function resolveLocation() {
  const w = config.weather || {};
  if (w.lat != null && w.lon != null) {
    resolvedCoords = { lat: w.lat, lon: w.lon, city: w.city || '' };
    return;
  }
  const parts = String(w.city || '').split(',').map((s) => s.trim());
  const name = parts[0], countryHint = (parts[1] || '').toLowerCase();
  if (!name) return;
  try {
    const g = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=es&format=json`,
      15000
    );
    let r = g.results && g.results[0];
    if (countryHint && g.results) {
      const m = g.results.find((x) => String(x.country || '').toLowerCase().includes(countryHint));
      if (m) r = m;
    }
    if (r) {
      resolvedCoords = { lat: r.latitude, lon: r.longitude, city: w.city || r.name };
      log('[weather] ubicacion:', r.name, r.country, '->', r.latitude, r.longitude);
    }
  } catch (e) {
    log('[weather] geocoding fallo -', e.message);
  }
}

/** Consulta el clima actual y lo envia al reproductor. */
async function fetchWeather() {
  if (!resolvedCoords) await resolveLocation();
  if (!resolvedCoords) return; // sin ubicacion configurada
  const { lat, lon, city } = resolvedCoords;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day'
    + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
  try {
    const j = await getJson(url, 15000);
    const c = j.current || {}, d = j.daily || {};
    lastWeather = {
      city,
      temp: Math.round(c.temperature_2m),
      code: c.weather_code,
      isDay: c.is_day === 1,
      humidity: Math.round(c.relative_humidity_2m),
      wind: Math.round(c.wind_speed_10m),
      max: Array.isArray(d.temperature_2m_max) ? Math.round(d.temperature_2m_max[0]) : null,
      min: Array.isArray(d.temperature_2m_min) ? Math.round(d.temperature_2m_min[0]) : null,
    };
    sendChannel('weather', lastWeather);
    log('[weather] OK', JSON.stringify(lastWeather));
  } catch (e) {
    log('[weather] FALLO -', e.message);
  }
}

// ----------------------------- Ventana / IPC -----------------------------

let mainWindow = null;
let rendererReady = false;

function sendChannel(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(channel, data);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    // Ajustes + reenvio de lo ultimo calculado al cargar el reproductor.
    sendChannel('settings', { imageSeconds: config.imageSeconds });
    sendChannel('playlist', lastPlaylist);
    sendChannel('images', lastImages);
    if (lastWeather) sendChannel('weather', lastWeather);
  });

  mainWindow.loadFile('player.html');
}

app.whenReady().then(() => {
  // media://v/<archivo> -> data/videos/<archivo>
  protocol.registerFileProtocol('media', (request, callback) => {
    const url = new URL(request.url);
    const name = path.basename(decodeURIComponent(url.pathname)); // evita path traversal
    callback({ path: path.join(VIDEOS_DIR, name) });
  });

  // img://v/<archivo> -> data/images/<archivo>
  protocol.registerFileProtocol('img', (request, callback) => {
    const url = new URL(request.url);
    const name = path.basename(decodeURIComponent(url.pathname));
    callback({ path: path.join(IMAGES_DIR, name) });
  });

  createWindow();

  // Salir del kiosko (los controles estan ocultos en modo kiosko).
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  // Primer ciclo inmediato y luego en intervalo fijo.
  tick();
  setInterval(tick, config.heartbeatSeconds * 1000);

  // Clima: ahora y luego cada 15 minutos.
  fetchWeather();
  setInterval(fetchWeather, 15 * 60 * 1000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
