# Cliente DigiSignage para TV Box (Android 11)

App nativa **Kotlin + WebView** equivalente al cliente Electron de `../client/`.
Reutiliza el mismo reproductor (`player.html`) y habla con el mismo servidor
(`https://digisingage.onrender.com`) usando el mismo contrato:

- `POST /api/heartbeat` `{deviceId, nombre}` → `{playlist[], images[]}`
- `GET /download/:filename` (videos) y `GET /image/:filename` (imágenes)
- Clima vía Open-Meteo (sin clave)

La sincronización (heartbeat, descarga/borrado de medios y clima) corre en un
**servicio en primer plano** (Kotlin/OkHttp); el reproductor corre en un **WebView**
a pantalla completa. Los medios se **descargan y cachean** en el dispositivo: si la red
cae, sigue reproduciendo lo local.

---

## 1. Requisitos (PC de desarrollo)

- **Android Studio** (recomendado) o JDK 17 + Android SDK + Gradle 8.9.
- Plataforma Android API 34 instalada (compileSdk).

> Este repo no incluye el `gradle-wrapper.jar` (binario). Para obtener `./gradlew`:
> abre el proyecto en **Android Studio** (genera el wrapper automáticamente) **o**
> ejecuta una vez `gradle wrapper --gradle-version 8.9` con Gradle instalado.

---

## 2. Compilar el APK

**Con Android Studio:** abre la carpeta `client-android/`, deja sincronizar Gradle y
usa *Build → Build Bundle(s)/APK(s) → Build APK(s)*.

**Por línea de comandos:**
```powershell
cd client-android
.\gradlew.bat assembleDebug      # APK de pruebas (firmado debug)
# o
.\gradlew.bat assembleRelease    # APK release (firmar con tu keystore)
```
Resultado debug: `app/build/outputs/apk/debug/app-debug.apk`.

---

## 3. Instalar en el TV Box

**Con ADB** (box con depuración USB/red activada):
```powershell
adb connect <IP_DEL_BOX>:5555        # si es por red
adb install -r app-debug.apk
```

**Por USB/archivo:** copia el `.apk` a un pendrive, ábrelo con un explorador en el box
y permite "instalar de orígenes desconocidos".

---

## 4. Configurar el dispositivo

1. Abre la app **una vez**. En el primer arranque crea:
   - `Android/data/com.digisignage.client/files/config.json` (con un **`deviceId` único**)
   - carpetas `videos/` e `images/` en esa misma ruta.
2. Edita `config.json` (por USB, ADB o un explorador de archivos):
   - `deviceName`: nombre legible y **único** (ej. `"Recepción"`).
   - `serverUrl`: ya apunta al servidor; cámbialo solo si usas otro.
   - `weather.city`: ciudad para el clima (ej. `"Valparaíso, Chile"`).
   ```json
   {
     "serverUrl": "https://digisingage.onrender.com",
     "deviceName": "Recepción",
     "heartbeatSeconds": 60,
     "imageSeconds": 6,
     "weather": { "lat": null, "lon": null, "city": "Valparaíso, Chile" },
     "deviceId": "(se genera solo; no lo edites)"
   }
   ```
   > Editar por ADB:
   > `adb pull /sdcard/Android/data/com.digisignage.client/files/config.json`
   > (edítalo y) `adb push config.json /sdcard/Android/data/com.digisignage.client/files/`
3. Reinicia la app. En el panel aparecerá **En Línea** con su nombre → asígnale playlist.

**Cada pantalla = un `deviceId` distinto.** No copies la carpeta `files/` de otro box.

---

## 5. Autostart al encender

La app incluye un `BootReceiver` que la lanza tras el arranque. En muchos TV box hay que:
- abrir la app **al menos una vez** después de instalar, y
- habilitarla en el **gestor de autoarranque** propio del box (si lo tiene).

---

## 6. Verificación rápida (end-to-end)

1. Conecta el box → en el panel debe figurar **En Línea**. Revisa logs:
   `adb logcat -s DigiSyncSvc DigiSync DigiWeather` → verás `[heartbeat] OK`.
2. Asigna una playlist de videos → se descargan a `files/videos/` y se reproducen en bucle.
3. Desconecta la red → el contenido local sigue reproduciéndose (no se borra).
4. Reordena en el panel → en ≤ `heartbeatSeconds` aplica el nuevo orden al cerrar la vuelta.
5. Con `weather.city` puesta, la franja de clima muestra temperatura y condición.
6. Reinicia el box → la app arranca sola a pantalla completa.

---

## 7. Notas

- **Salir de la app** (mantenimiento): botón Atrás/Inicio del control remoto del box
  (no es kiosko "duro"; fue la opción elegida por simplicidad de mantenimiento).
- **Imágenes (slider):** soportadas de extremo a extremo. El servidor ya devuelve `images`
  en el heartbeat y expone `GET /image/:filename`; en el panel hay una **biblioteca de
  imágenes** y, por dispositivo, una sección **Imágenes (slider)** para asignarlas.
- **HTTP en claro:** `usesCleartextTraffic` está habilitado para permitir servidores
  `http://` en LAN; en producción usa `https://`.
