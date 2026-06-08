'use strict';

/**
 * ============================================================================
 *  Metadatos de medios (fecha, resolución, tamaño, duración)
 * ============================================================================
 *  Para que el admin reconozca qué archivo encaja en cada zona, las bibliotecas
 *  muestran datos del archivo. Aquí se calculan:
 *    - tamaño (bytes) y fecha (mtime): siempre, vía fs.statSync.
 *    - resolución de IMÁGENES: parser propio (PNG/JPEG/GIF/WEBP/BMP), sin deps.
 *    - resolución + duración de VIDEO: vía ffprobe SI está instalado; si no, se
 *      omiten (degradación elegante; p. ej. server sin ffmpeg).
 *
 *  Los resultados se cachean por (kind:name:mtimeMs:bytes) para no recomputar
 *  (sobre todo ffprobe) en cada request.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// --------------------------- Resolución de imágenes ---------------------------

/** Lee dimensiones de una imagen a partir de su cabecera. Devuelve {width,height} o null. */
function imageSize(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length < 24) return null;

  // PNG: firma de 8 bytes + IHDR (width @16, height @20, big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: 'GIF8' + width @6, height @8 (little-endian).
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP: 'BM' + width @18, height @22 (int32 little-endian; alto puede ser negativo).
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }

  // WEBP: 'RIFF'....'WEBP' + chunk VP8 / VP8L / VP8X.
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return webpSize(buf);
  }

  // JPEG: FFD8 + recorrer marcadores hasta un SOF con las dimensiones.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return jpegSize(buf);
  }

  return null;
}

function webpSize(buf) {
  const fourcc = buf.toString('ascii', 12, 16);
  try {
    if (fourcc === 'VP8 ') {
      // Lossy: tras el frame tag (3 bytes) y el start code, dims @26/@28 (14 bits).
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 1 byte de firma (0x2f) + 14+14 bits empacados desde @21.
      const b = buf.readUInt32LE(21);
      const width = (b & 0x3fff) + 1;
      const height = ((b >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (fourcc === 'VP8X') {
      // Extended: canvas = 24 bits (little-endian) + 1, desde @24 (ancho) y @27 (alto).
      const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
      const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
      return { width, height };
    }
  } catch {
    return null;
  }
  return null;
}

function jpegSize(buf) {
  let off = 2;
  const len = buf.length;
  while (off + 9 < len) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15 contienen las dimensiones, excepto C4 (DHT), C8 (JPG) y CC (DAC).
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return { width, height };
    }
    // Salta al siguiente marcador usando la longitud del segmento.
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2) return null;
    off += 2 + segLen;
  }
  return null;
}

// --------------------------- Resolución/duración de video (ffprobe) ---------------------------

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let ffprobeUnavailable = false; // se activa tras un ENOENT para no reintentar

/** Ejecuta ffprobe sobre un video. Devuelve {width,height,duration} o null. */
function probeVideo(filePath) {
  return new Promise((resolve) => {
    if (ffprobeUnavailable) return resolve(null);
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ];
    execFile(FFPROBE, args, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') ffprobeUnavailable = true; // no hay ffmpeg
        return resolve(null);
      }
      try {
        const j = JSON.parse(stdout);
        const s = (j.streams && j.streams[0]) || {};
        const durRaw = j.format && j.format.duration;
        const duration = durRaw != null && !Number.isNaN(Number(durRaw))
          ? Math.round(Number(durRaw)) : null;
        const width = Number(s.width) || null;
        const height = Number(s.height) || null;
        if (!width && !height && duration == null) return resolve(null);
        resolve({ width, height, duration });
      } catch {
        resolve(null);
      }
    });
  });
}

// --------------------------- Listado con metadatos (con caché) ---------------------------

const cache = new Map(); // clave -> { name, bytes, mtime, width?, height?, duration? }

async function metaFor(dir, name, kind) {
  const full = path.join(dir, name);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return { name }; // archivo desaparecido entre readdir y stat
  }
  const key = `${kind}:${name}:${st.mtimeMs}:${st.size}`;
  if (cache.has(key)) return cache.get(key);

  const meta = { name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  if (kind === 'image') {
    const dim = imageSize(full);
    if (dim) { meta.width = dim.width; meta.height = dim.height; }
  } else if (kind === 'video') {
    const v = await probeVideo(full);
    if (v) {
      if (v.width) meta.width = v.width;
      if (v.height) meta.height = v.height;
      if (v.duration != null) meta.duration = v.duration;
    }
  }
  cache.set(key, meta);
  return meta;
}

/**
 * Devuelve los metadatos de una lista de archivos (kind: 'image' | 'video').
 * Los no cacheados se calculan en paralelo.
 */
function listWithMeta(dir, names, kind) {
  return Promise.all(names.map((n) => metaFor(dir, n, kind)));
}

module.exports = { imageSize, probeVideo, listWithMeta };
