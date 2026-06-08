'use strict';

/**
 * ============================================================================
 *  Catalogo de LAYOUTS y WIDGETS (fuente unica de verdad)
 * ============================================================================
 *  Una pantalla (dispositivo) tiene un LAYOUT: un "preset" de zonas y, en cada
 *  zona, un WIDGET con su configuracion. El layout se guarda como JSON en la
 *  columna dispositivos.layout_json.
 *
 *  Forma del layout:
 *    {
 *      preset: "cuatro",
 *      zones: {
 *        a: { widget: "video",    config: { items: ["v1.mp4"] } },
 *        b: { widget: "imagenes", config: { modo: "slider",
 *               items: [ {file:"i1.jpg", segundos:6}, {file:"i2.jpg", segundos:10} ] } },
 *        c: { widget: "reloj",    config: {} },
 *        d: { widget: "clima",    config: {} }
 *      }
 *    }
 *
 *  Reglas:
 *    - Las claves de zona (slots) las define cada preset.
 *    - Como maximo UNA zona puede usar el widget "video" (evita saturar al cliente).
 *    - El catalogo de widgets es extensible: agregar uno nuevo aqui + su mount()
 *      en el reproductor (player.html).
 * ============================================================================
 */

// Segundos por defecto de cada imagen del slider cuando no se especifica.
const DEFAULT_IMAGE_SECONDS = 6;

/**
 * Presets disponibles. Cada uno declara sus "slots" (ids de zona) y los
 * metadatos de grilla que consume el dashboard y el reproductor para construir
 * la disposicion. `areas`/`columns`/`rows` reflejan CSS grid.
 */
const PRESETS = {
  solo: {
    label: '1 zona',
    slots: ['a'],
    grid: { columns: '1fr', rows: '1fr', areas: '"a"' },
  },
  'dos-iguales': {
    label: '2 zonas iguales',
    slots: ['a', 'b'],
    grid: { columns: '1fr 1fr', rows: '1fr', areas: '"a b"' },
  },
  'dos-asimetrico': {
    label: '2 zonas (una mayor)',
    slots: ['a', 'b'],
    grid: { columns: '2fr 1fr', rows: '1fr', areas: '"a b"' },
  },
  cuatro: {
    label: '4 zonas',
    slots: ['a', 'b', 'c', 'd'],
    // a = principal (video), b = columna derecha (slider),
    // c = franja inferior izq (clima), d = franja inferior der (reloj).
    grid: {
      columns: '1fr 400px',
      rows: '1fr 280px',
      areas: '"a b" "c d"',
    },
  },
};

/**
 * Catalogo de widgets. `content` indica si el widget aporta archivos de medios
 * (para la sincronizacion del cliente). El reproductor implementa el render.
 */
const WIDGETS = {
  video: { label: 'Video', content: 'video' },
  imagenes: { label: 'Imágenes', content: 'imagenes' },
  reloj: { label: 'Reloj', content: null },
  clima: { label: 'Clima', content: null },
};

const PRESET_IDS = Object.keys(PRESETS);
const WIDGET_IDS = Object.keys(WIDGETS);

class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.code = 'LAYOUT_INVALIDO';
  }
}

/** Normaliza y valida la config de un widget de imagenes. */
function normalizeImagenes(config) {
  const modo = config && config.modo === 'estatica' ? 'estatica' : 'slider';
  const rawItems = Array.isArray(config && config.items) ? config.items : [];

  const items = rawItems
    .map((it) => {
      // Acepta string (solo nombre) u objeto {file, segundos}.
      const file = typeof it === 'string' ? it : (it && it.file);
      if (!file || typeof file !== 'string') return null;
      let segundos = Number(it && it.segundos);
      if (!Number.isFinite(segundos) || segundos <= 0) segundos = DEFAULT_IMAGE_SECONDS;
      return { file: String(file).trim(), segundos: Math.round(segundos) };
    })
    .filter(Boolean);

  // En modo estatico solo se usa la primera imagen.
  const finalItems = modo === 'estatica' ? items.slice(0, 1) : items;
  return { modo, items: finalItems };
}

/** Normaliza y valida la config de un widget de video. */
function normalizeVideo(config) {
  const rawItems = Array.isArray(config && config.items) ? config.items : [];
  const items = rawItems
    .map((it) => (typeof it === 'string' ? it : (it && it.file)))
    .filter((f) => f && typeof f === 'string')
    .map((f) => String(f).trim());
  return { items };
}

/**
 * Valida y normaliza un layout completo. Lanza LayoutError con mensaje legible
 * si no cumple. Devuelve el layout normalizado listo para guardar.
 */
function validateLayout(layout) {
  if (!layout || typeof layout !== 'object') {
    throw new LayoutError('Layout requerido');
  }
  const preset = PRESETS[layout.preset];
  if (!preset) {
    throw new LayoutError(`Preset desconocido: ${layout.preset}`);
  }

  const zonesIn = layout.zones && typeof layout.zones === 'object' ? layout.zones : {};
  const zones = {};
  let videoCount = 0;

  for (const slot of preset.slots) {
    const z = zonesIn[slot] || {};
    const widget = z.widget;
    if (!WIDGETS[widget]) {
      throw new LayoutError(`Zona "${slot}": widget desconocido o ausente (${widget})`);
    }

    let config = {};
    if (widget === 'video') {
      videoCount++;
      config = normalizeVideo(z.config);
    } else if (widget === 'imagenes') {
      config = normalizeImagenes(z.config);
    } else {
      // reloj / clima: config libre (se conserva tal cual si es objeto).
      config = z.config && typeof z.config === 'object' ? z.config : {};
    }

    zones[slot] = { widget, config };
  }

  if (videoCount > 1) {
    throw new LayoutError('Solo se permite una zona con video por pantalla');
  }

  return { preset: layout.preset, zones };
}

/**
 * Extrae los archivos de medios referenciados por el layout, para que el cliente
 * sepa que descargar/conservar. Devuelve { videos:[...], images:[...] } sin
 * duplicados, preservando el orden de aparicion.
 */
function flattenMedia(layout) {
  const videos = [];
  const images = [];
  const safe = layout && layout.zones ? layout.zones : {};
  for (const slot of Object.keys(safe)) {
    const z = safe[slot];
    if (!z || !z.widget) continue;
    if (z.widget === 'video') {
      for (const f of (z.config && z.config.items) || []) {
        if (f && !videos.includes(f)) videos.push(f);
      }
    } else if (z.widget === 'imagenes') {
      for (const it of (z.config && z.config.items) || []) {
        const f = typeof it === 'string' ? it : (it && it.file);
        if (f && !images.includes(f)) images.push(f);
      }
    }
  }
  return { videos, images };
}

/**
 * Construye un layout preset "cuatro" a partir de las listas antiguas
 * (por-dispositivo) de video e imagenes, para migrar sin perder contenido.
 */
function migrateFromPlaylists(videoList, imageList) {
  const videos = Array.isArray(videoList) ? videoList : [];
  const images = Array.isArray(imageList) ? imageList : [];
  return {
    preset: 'cuatro',
    zones: {
      a: { widget: 'video', config: { items: videos.map((f) => String(f).trim()) } },
      b: {
        widget: 'imagenes',
        config: {
          modo: 'slider',
          items: images.map((f) => ({ file: String(f).trim(), segundos: DEFAULT_IMAGE_SECONDS })),
        },
      },
      c: { widget: 'clima', config: {} },
      d: { widget: 'reloj', config: {} },
    },
  };
}

/** Layout vacio por defecto (preset "cuatro" sin contenido). */
function defaultLayout() {
  return migrateFromPlaylists([], []);
}

module.exports = {
  DEFAULT_IMAGE_SECONDS,
  PRESETS,
  WIDGETS,
  PRESET_IDS,
  WIDGET_IDS,
  LayoutError,
  validateLayout,
  flattenMedia,
  migrateFromPlaylists,
  defaultLayout,
};
