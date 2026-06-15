'use strict';

/**
 * Puente seguro entre el proceso principal y el reproductor (player.html).
 * Expone solo lo necesario: una suscripcion a las actualizaciones de playlist.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signage', {
  // cb recibe el layout actual ({ preset, zones }) para construir las zonas.
  onLayout: (cb) => ipcRenderer.on('layout', (_event, layout) => cb(layout)),
  // cb recibe un array de nombres de video (en orden de reproduccion).
  onPlaylist: (cb) => ipcRenderer.on('playlist', (_event, videos) => cb(videos)),
  // cb recibe un array de nombres de imagen (para el slider).
  onImages: (cb) => ipcRenderer.on('images', (_event, images) => cb(images)),
  // cb recibe los ajustes ({ imageSeconds, ... }).
  onSettings: (cb) => ipcRenderer.on('settings', (_event, settings) => cb(settings)),
  // cb recibe el clima actual ({ city, temp, code, ... }).
  onWeather: (cb) => ipcRenderer.on('weather', (_event, weather) => cb(weather)),
  // cb recibe { claimCode } si la pantalla esta sin asignar, o null si ya lo esta.
  onPairing: (cb) => ipcRenderer.on('pairing', (_event, pairing) => cb(pairing)),
});
