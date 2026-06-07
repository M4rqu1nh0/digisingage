'use strict';

/**
 * Capa de acceso a datos (SQLite via better-sqlite3).
 *
 * better-sqlite3 es sincrono: simplifica enormemente el codigo (no hay
 * callbacks ni promesas) y es mas que suficiente para la carga de un
 * sistema de carteleria con decenas/cientos de dispositivos.
 *
 * Esquema:
 *   dispositivos(id, nombre, ultima_conexion, ip_actual)
 *   playlists(id, dispositivo_id, video_url_o_nombre, orden)
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'signage.db');
const db = new Database(DB_PATH);

// WAL mejora la concurrencia lectura/escritura (muchos heartbeats simultaneos).
db.pragma('journal_mode = WAL');

// --- Creacion del esquema (idempotente) ---
db.exec(`
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

// ----------------------- Sentencias preparadas -----------------------

const stmts = {
  getDevice: db.prepare('SELECT * FROM dispositivos WHERE id = ?'),

  insertDevice: db.prepare(`
    INSERT INTO dispositivos (id, nombre, ultima_conexion, ip_actual)
    VALUES (@id, @nombre, @ultima_conexion, @ip_actual)
  `),

  touchDevice: db.prepare(`
    UPDATE dispositivos
       SET ultima_conexion = @ultima_conexion,
           ip_actual       = @ip_actual
     WHERE id = @id
  `),

  renameDevice: db.prepare('UPDATE dispositivos SET nombre = ? WHERE id = ?'),

  listDevices: db.prepare('SELECT * FROM dispositivos ORDER BY nombre COLLATE NOCASE'),

  deleteDevice: db.prepare('DELETE FROM dispositivos WHERE id = ?'),

  getPlaylist: db.prepare(`
    SELECT video_url_o_nombre, orden
      FROM playlists
     WHERE dispositivo_id = ?
     ORDER BY orden ASC
  `),

  clearPlaylist: db.prepare('DELETE FROM playlists WHERE dispositivo_id = ?'),

  insertPlaylistItem: db.prepare(`
    INSERT INTO playlists (dispositivo_id, video_url_o_nombre, orden)
    VALUES (@dispositivo_id, @video, @orden)
  `),

  getImagePlaylist: db.prepare(`
    SELECT imagen, orden
      FROM image_playlists
     WHERE dispositivo_id = ?
     ORDER BY orden ASC
  `),

  clearImagePlaylist: db.prepare('DELETE FROM image_playlists WHERE dispositivo_id = ?'),

  insertImagePlaylistItem: db.prepare(`
    INSERT INTO image_playlists (dispositivo_id, imagen, orden)
    VALUES (@dispositivo_id, @imagen, @orden)
  `),
};

// ----------------------------- API del modulo -----------------------------

/** Devuelve la lista ordenada de nombres de video de un dispositivo. */
function getPlaylistArray(deviceId) {
  return stmts.getPlaylist.all(deviceId).map((r) => r.video_url_o_nombre);
}

/** Devuelve la lista ordenada de nombres de imagen de un dispositivo. */
function getImagePlaylistArray(deviceId) {
  return stmts.getImagePlaylist.all(deviceId).map((r) => r.imagen);
}

/**
 * Registra el dispositivo si no existe y actualiza ultima_conexion + IP.
 * Devuelve la playlist ordenada (array de nombres).
 */
const heartbeat = db.transaction((deviceId, ip, nombreSugerido) => {
  const now = new Date().toISOString();
  const existing = stmts.getDevice.get(deviceId);

  if (!existing) {
    stmts.insertDevice.run({
      id: deviceId,
      nombre: nombreSugerido || `Dispositivo ${deviceId.slice(0, 8)}`,
      ultima_conexion: now,
      ip_actual: ip,
    });
  } else {
    stmts.touchDevice.run({ id: deviceId, ultima_conexion: now, ip_actual: ip });
  }

  return {
    playlist: getPlaylistArray(deviceId),
    images: getImagePlaylistArray(deviceId),
  };
});

/** Reemplaza por completo la playlist de un dispositivo con el array dado. */
const savePlaylist = db.transaction((deviceId, videos) => {
  // Garantiza que el dispositivo exista (alta manual desde el panel).
  if (!stmts.getDevice.get(deviceId)) {
    stmts.insertDevice.run({
      id: deviceId,
      nombre: `Dispositivo ${deviceId.slice(0, 8)}`,
      ultima_conexion: null,
      ip_actual: null,
    });
  }

  stmts.clearPlaylist.run(deviceId);
  videos.forEach((video, idx) => {
    stmts.insertPlaylistItem.run({
      dispositivo_id: deviceId,
      video: String(video).trim(),
      orden: idx,
    });
  });

  return getPlaylistArray(deviceId);
});

/** Reemplaza por completo la playlist de imagenes de un dispositivo. */
const saveImagePlaylist = db.transaction((deviceId, imagenes) => {
  // Garantiza que el dispositivo exista (alta manual desde el panel).
  if (!stmts.getDevice.get(deviceId)) {
    stmts.insertDevice.run({
      id: deviceId,
      nombre: `Dispositivo ${deviceId.slice(0, 8)}`,
      ultima_conexion: null,
      ip_actual: null,
    });
  }

  stmts.clearImagePlaylist.run(deviceId);
  imagenes.forEach((imagen, idx) => {
    stmts.insertImagePlaylistItem.run({
      dispositivo_id: deviceId,
      imagen: String(imagen).trim(),
      orden: idx,
    });
  });

  return getImagePlaylistArray(deviceId);
});

/** Lista de dispositivos con su estado (online/offline) y su playlist. */
function listDevicesWithStatus(onlineWindowMin) {
  const limitMs = onlineWindowMin * 60 * 1000;
  const now = Date.now();

  return stmts.listDevices.all().map((d) => {
    const lastMs = d.ultima_conexion ? new Date(d.ultima_conexion).getTime() : 0;
    const online = lastMs > 0 && now - lastMs <= limitMs;
    return {
      id: d.id,
      nombre: d.nombre,
      ip_actual: d.ip_actual,
      ultima_conexion: d.ultima_conexion,
      online,
      playlist: getPlaylistArray(d.id),
      images: getImagePlaylistArray(d.id),
    };
  });
}

function renameDevice(deviceId, nombre) {
  return stmts.renameDevice.run(nombre, deviceId).changes > 0;
}

function deleteDevice(deviceId) {
  stmts.clearPlaylist.run(deviceId);
  stmts.clearImagePlaylist.run(deviceId);
  return stmts.deleteDevice.run(deviceId).changes > 0;
}

function deviceExists(deviceId) {
  return !!stmts.getDevice.get(deviceId);
}

module.exports = {
  db,
  heartbeat,
  savePlaylist,
  saveImagePlaylist,
  getPlaylistArray,
  getImagePlaylistArray,
  listDevicesWithStatus,
  renameDevice,
  deleteDevice,
  deviceExists,
};
