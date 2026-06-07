# Cliente DigiSignage standalone (Electron portable)

Cliente empaquetado como app **Electron portable**: incluye su propio reproductor
(Chromium) y la sincronización (Node). En cada pantalla **NO se instala nada**
(ni Node, ni npm, ni Chrome): solo copiar una carpeta y ejecutar.

---

## A) Generar el ejecutable (UNA vez, en el PC de desarrollo)

Requiere Node.js instalado **solo en este PC** (no en las pantallas).

```
cd client
npm install        # descarga electron + electron-builder (solo aquí)
npm run dist        # genera dist/win-unpacked/
```

Resultado: la carpeta **`dist/win-unpacked/`** con `DigiSignage.exe` y `resources/`.
Esa carpeta es el cliente portable.

> Probar en desarrollo sin empaquetar: `npm start` (abre la ventana kiosko).
> Salir del modo kiosko: **Ctrl + Shift + Q**.

---

## B) Instalar en cada pantalla (copiar y ejecutar)

1. **Copia** la carpeta `win-unpacked` a la pantalla (USB/red). Renómbrala, p.ej. `DigiSignage`.
   - No copies ninguna carpeta `data/` de otra máquina (contiene su `deviceId`).
2. Doble clic en **`DigiSignage.exe`**. El primer arranque crea, junto al .exe:
   - `data/config.json` (con un **`deviceId` único** autogenerado)
   - `data/videos/` (donde se descargan los videos)
3. **Cierra** la app (Ctrl + Shift + Q) y edita **`data/config.json`**:
   - `deviceName`: un nombre único y legible (ej. `"Recepción"`).
   - `serverUrl`: ya apunta al servidor (Render); cámbialo solo si usas otro.
4. Vuelve a abrir `DigiSignage.exe` → arranca a pantalla completa.
5. En el panel `https://digisingage.onrender.com/` aparecerá la pantalla
   **En Línea** con su nombre → asígnale su playlist.

`data/config.json` de ejemplo:
```json
{
  "serverUrl": "https://digisingage.onrender.com",
  "deviceName": "Recepción",
  "heartbeatSeconds": 60,
  "deviceId": "(se genera solo; no lo edites)"
}
```

---

## Notas
- **Audio:** los videos se reproducen con sonido. Revisa el volumen de Windows y
  la salida correcta (HDMI a la TV).
- **Cada pantalla = un `deviceId` distinto.** Si dos equipos aparecen como uno
  solo en el panel, es que copiaste la carpeta `data/` de otra máquina: bórrala y
  vuelve a abrir para que se regenere.
- **Sin autostart:** la app no arranca sola al encender el equipo. Si lo
  necesitas, crea un acceso directo a `DigiSignage.exe` en la carpeta
  `shell:startup` de Windows.
- **Tamaño:** la carpeta portable pesa ~150–250 MB (incluye Chromium); es normal.
- **Reproducir repetidos:** desde el panel puedes duplicar un video (botón ⧉)
  para intercalar un spot entre otros; el cliente lo respeta sin descargarlo dos veces.
