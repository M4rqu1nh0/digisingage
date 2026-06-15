# DigiSignage — Sistema de Cartelería Digital

Sistema básico, robusto y automatizado de Digital Signage compuesto por:

1. **Admin Central** (`server/`) — Panel web + API + SQLite.
2. **Cliente de PC remoto** (`client/`) — Sincronizador en segundo plano + reproductor Chrome en modo kiosko.

---

## 1. Estructura del proyecto

```
DigiSingage/
├── README.md
│
├── server/                      # COMPONENTE 1: Admin Central
│   ├── package.json
│   ├── .env.example             # plantilla de configuración
│   ├── .env                     # configuración real (credenciales, puerto…)
│   ├── server.js                # API Express + auth JWT + descargas
│   ├── db.js                    # capa SQLite (better-sqlite3)
│   ├── signage.db               # (se crea solo al arrancar)
│   ├── media/                   # videos MAESTROS que se distribuyen
│   │   └── LEEME.txt
│   ├── images/                  # imágenes MAESTRAS para el slider
│   │   └── (se crea sola al arrancar)
│   └── public/                  # frontend del administrador
│       ├── login.html
│       ├── dashboard.html
│       └── css/styles.css
│
└── client/                      # COMPONENTE 2: PC remoto (se copia a C:\Signage)
    ├── package.json
    ├── config.json              # serverUrl, deviceId, carpeta de videos…
    ├── sync.js                  # heartbeat + descarga/borrado + JSON local
    ├── index.html               # reproductor a pantalla completa
    └── start-kiosk.bat          # lanza sync.js + Chrome en kiosko
```

> En cada PC de pantalla, el contenido de `client/` se despliega en **`C:\Signage\`**.
> Los videos descargados viven en **`C:\Signage\videos\`** y el reproductor lee
> **`C:\Signage\current_playlist.json`**.

---

## 2. Arquitectura y flujo

```
        ┌──────────────────────────── ADMIN CENTRAL (server/) ───────────────────────────┐
        │  Express + SQLite                                                                │
        │  ┌──────────────┐   POST /api/login (JWT cookie)   ┌──────────────────────────┐ │
        │  │  dashboard    │ <───────────────────────────────│  Navegador del admin     │ │
        │  │  /api/admin/* │   GET /api/admin/devices         └──────────────────────────┘ │
        │  └──────┬───────┘   POST /api/admin/playlist                                      │
        │         │                                                                          │
        │   SQLite (dispositivos, playlists)        GET /download/:file  (videos maestros)  │
        └─────────┼──────────────────────────────────────────────┬───────────────────────-┘
                  │  POST /api/heartbeat (cada 60s)                │  descarga de videos
                  │  └─> responde { playlist: [...] }              │
        ┌─────────▼───────────────────────────────────────────────▼───────────────────────┐
        │  CLIENTE  (C:\Signage\)                                                            │
        │  sync.js  ──► current_playlist.json  ──►  index.html (Chrome --kiosk en la TV)    │
        │            ──► C:\Signage\videos\ (descarga/borra)                                 │
        └───────────────────────────────────────────────────────────────────────────────────┘
```

- **Heartbeat (cada 60 s):** el cliente reporta su `deviceId` → el servidor actualiza
  `ultima_conexion` + `ip_actual` y responde con `status:"ok"` + la **playlist ordenada**.
- **Vinculación de pantallas:** en el primer arranque, una pantalla nueva se registra
  *sin asignar* y el heartbeat responde `status:"unclaimed"` con un **código individual**
  que la pantalla muestra a pantalla completa. El admin lo ingresa en el panel
  (*Dispositivos → «Vincular pantalla»*) para asignar esa pantalla a su empresa. Así se
  pueden clonar/instalar clientes sin pre-configurar nada; la asignación ocurre al
  iniciar el cliente por primera vez.
- **Monitoreo:** si `ultima_conexion` < 3 min → 🟢 *En Línea*; si no → 🔴 *Fuera de Línea*.
- **Sincronización de archivos:** el cliente descarga lo que falta y borra lo que sobra.
- **Reproducción:** `index.html` reproduce en bucle y recarga el JSON al cerrar cada vuelta.

---

## 3. Endpoints de la API

| Método | Ruta                          | Auth  | Descripción |
|--------|-------------------------------|-------|-------------|
| POST   | `/api/login`                  | —     | Login admin (credenciales de `.env`) → cookie JWT |
| POST   | `/api/logout`                 | —     | Cierra sesión |
| GET    | `/api/me`                     | JWT   | Verifica sesión |
| POST   | `/api/heartbeat`              | —     | `{deviceId,nombre}` → `status:"ok"` con `{layout,playlist,images}`, o `status:"unclaimed"` con `claimCode` si la pantalla aún no está vinculada |
| GET    | `/download/:filename`         | —     | Descarga un video maestro de `server/media/` |
| GET    | `/image/:filename`            | —     | Descarga una imagen maestra de `server/images/` |
| GET    | `/api/admin/devices`          | JWT   | Lista dispositivos con estado online/offline (incluye `playlist` e `images`) |
| POST   | `/api/admin/playlist`         | JWT   | `{deviceId,videos[]}` → guarda el orden de videos |
| POST   | `/api/admin/image-playlist`   | JWT   | `{deviceId,images[]}` → guarda el orden de imágenes (slider) |
| POST   | `/api/admin/claim`            | JWT   | `{code,nombre?}` → vincula una pantalla a la empresa por su código individual |
| POST   | `/api/admin/device`           | JWT   | `{deviceId,nombre}` → renombrar un dispositivo |
| DELETE | `/api/admin/device/:id`       | JWT   | Elimina dispositivo y sus listas (videos + imágenes) |
| GET    | `/api/admin/media`            | JWT   | Lista videos disponibles en el servidor |
| POST   | `/api/admin/media`            | JWT   | Sube un video (multipart, campo `video`). `413` si supera `MAX_UPLOAD_MB` |
| GET    | `/api/admin/images`           | JWT   | Lista imágenes disponibles en el servidor |
| POST   | `/api/admin/image`            | JWT   | Sube una imagen (multipart, campo `image`). `413` si supera `MAX_UPLOAD_MB` |

---

## 4. Puesta en marcha del SERVIDOR

```powershell
cd C:\proyectos\DigiSingage\server
copy .env.example .env       # luego edita credenciales/puerto si quieres
npm install
npm start
```

Abre **http://localhost:4000/login.html** (usuario/clave por defecto: `admin` / `admin123`).

Coloca tus videos maestros en `server/media/` (p. ej. `promo1.mp4`), o **súbelos
desde el panel**: botón **⬆ Subir video** o **arrastra y suelta** los archivos en la
zona del dashboard. Muestra el **% de avance** por archivo y respeta el límite
`MAX_UPLOAD_MB` del `.env` (por defecto 500 MB; se valida en cliente y servidor).

> **Acceso desde otros PCs:** usa la IP del servidor, p. ej. `http://192.168.1.50:4000`,
> y pon esa misma URL en el `config.json` de cada cliente. Abre el puerto 4000 en el
> Firewall de Windows (ver más abajo).

---

## 5. Puesta en marcha del CLIENTE (cada PC con TV)

1. Instala **Node.js** y **Google Chrome** en el PC.
2. Crea la carpeta y copia el cliente:
   ```powershell
   mkdir C:\Signage
   copy C:\proyectos\DigiSingage\client\*  C:\Signage\
   cd C:\Signage
   npm install
   ```
3. Edita **`C:\Signage\config.json`**:
   ```json
   {
     "serverUrl": "http://192.168.1.50:4000",
     "deviceId": "recepcion-01",
     "deviceName": "Pantalla Recepción",
     "heartbeatSeconds": 60,
     "videosDir": "C:\\Signage\\videos"
   }
   ```
   > Si dejas `deviceId` vacío, `sync.js` genera un UUID y lo guarda solo.
   > Apunta ese `deviceId` para asignarle su playlist en el panel.
4. Prueba manual:
   ```powershell
   cd C:\Signage
   node sync.js            # debe imprimir [heartbeat] OK y bajar videos
   ```
5. Doble clic en **`start-kiosk.bat`** → arranca sync + Chrome a pantalla completa.

> Para **salir** del modo kiosko: `Alt + F4`.

---

## 6. Configuración de Windows para kiosko 24/7

> Ejecuta PowerShell **como Administrador**.

### 6.1 Desactivar suspensión y apagado de pantalla

```powershell
# Nunca suspender ni apagar la pantalla (CA = enchufado, DC = batería)
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0

# Asegurar el plan "Alto rendimiento"
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
```

### 6.2 Permitir el puerto del servidor en el Firewall (solo en el PC servidor)

```powershell
New-NetFirewallRule -DisplayName "DigiSignage 4000" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
```

### 6.3 Inicio de sesión automático de Windows (auto-login)

**Opción A — netplwiz (gráfico, recomendado):**
1. `Win + R` → escribe `netplwiz` → Enter.
2. Selecciona el usuario y **desmarca** “Los usuarios deben escribir su nombre y contraseña”.
3. Aplicar → ingresa la contraseña del usuario para confirmar.

**Opción B — Registro (PowerShell como Administrador):**
```powershell
$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty $key -Name AutoAdminLogon -Value "1"
Set-ItemProperty $key -Name DefaultUserName -Value "TU_USUARIO"
Set-ItemProperty $key -Name DefaultPassword -Value "TU_PASSWORD"
# Opcional si el equipo está en dominio:
# Set-ItemProperty $key -Name DefaultDomainName -Value "TU_DOMINIO"
```

### 6.4 Lanzar el kiosko al arrancar

**Opción A — Carpeta de Inicio (más simple):**
1. `Win + R` → `shell:startup` → Enter.
2. Crea un **acceso directo** a `C:\Signage\start-kiosk.bat` dentro de esa carpeta.

   ```powershell
   $WshShell = New-Object -ComObject WScript.Shell
   $lnk = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\DigiSignage.lnk")
   $lnk.TargetPath = "C:\Signage\start-kiosk.bat"
   $lnk.WorkingDirectory = "C:\Signage"
   $lnk.Save()
   ```

**Opción B — Programador de tareas (más robusto, reinicia si se cierra):**
```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Signage\start-kiosk.bat" -WorkingDirectory "C:\Signage"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "DigiSignage Kiosk" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
```

### 6.5 Comando de Chrome en modo kiosko (referencia)

El `.bat` ya lo ejecuta, pero como referencia manual:
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --kiosk --start-fullscreen `
  --user-data-dir="C:\Signage\chrome-profile" `
  --allow-file-access-from-files `
  --autoplay-policy=no-user-gesture-required `
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble `
  "file:///C:/Signage/index.html"
```

> `--allow-file-access-from-files` es necesario para que la página local pueda leer
> `current_playlist.json` mediante `fetch`. `--autoplay-policy=...` permite el autoplay.

---

## 7. Prueba rápida de extremo a extremo

1. Arranca el servidor (`npm start` en `server/`) y pon un par de `.mp4` en `server/media/`.
2. Entra al panel, crea un dispositivo con `deviceId = recepcion-01` y escribe en su
   playlist los nombres de tus videos (uno por línea), **Guardar orden**.
3. En el cliente, pon ese mismo `deviceId` en `config.json` y ejecuta `node sync.js`:
   verás cómo descarga los videos a `C:\Signage\videos\` y crea `current_playlist.json`.
4. Abre `index.html` (o `start-kiosk.bat`): la TV reproduce en bucle.
5. Cambia el orden en el panel → en ≤ 60 s el cliente sincroniza y, al cerrar la vuelta,
   el reproductor aplica el nuevo orden.

---

## 8. Notas de seguridad / producción

- Cambia `ADMIN_USER`, `ADMIN_PASS` y `JWT_SECRET` en `.env`.
- El `/api/heartbeat` y `/download` son públicos por simplicidad; en producción
  conviene añadir un token por dispositivo y servir todo por **HTTPS** (reverse proxy).
- `better-sqlite3` usa modo WAL para soportar muchos heartbeats concurrentes.
