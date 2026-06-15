package com.digisignage.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray

/**
 * Servicio en primer plano que ejecuta el ciclo de sincronización y clima.
 * Equivalente a los setInterval(tick) / setInterval(fetchWeather) del main.js de
 * Electron. Empuja los resultados a la WebView a través de SignageState.
 */
class SyncService : Service() {

    private val TAG = "DigiSyncSvc"
    private val CHANNEL_ID = "digisignage_sync"
    private val NOTIF_ID = 1

    // Sondeo rapido (segundos) mientras la pantalla no esta activa (sin vincular o
    // esperando que el admin configure el contenido), para activarse casi al instante.
    private val PAIRING_POLL_SECONDS = 3L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var cfg: Config

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        cfg = Config.load(this)
        startForeground(NOTIF_ID, buildNotification())

        // Ajustes iniciales para el reproductor (imageSeconds).
        SignageState.emit("settings", "{\"imageSeconds\":${cfg.imageSeconds}}")

        startSyncLoop()
        startWeatherLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    // ----------------------------- Ciclos -----------------------------

    private fun startSyncLoop() = scope.launch {
        while (isActive) {
            val active = tick()
            // Activa: intervalo normal. Sin vincular o esperando contenido: sondeo rapido.
            val secs = if (active) cfg.heartbeatSeconds.toLong() else PAIRING_POLL_SECONDS
            delay(secs * 1000L)
        }
    }

    private fun startWeatherLoop() = scope.launch {
        val weather = Weather(cfg.weather)
        while (isActive) {
            weather.fetch()?.let { SignageState.emit("weather", it.toString()) }
            delay(15 * 60 * 1000L)
        }
    }

    /**
     * Un ciclo de heartbeat + sincronización. Devuelve true si la pantalla esta
     * ACTIVA (vinculada y configurada); false si esta sin vincular o esperando
     * contenido, para que el loop sondee mas rapido.
     */
    private fun tick(): Boolean {
        try {
            val hb = Sync.heartbeat(cfg.serverUrl, cfg.deviceId, cfg.deviceName)

            // Pantalla sin asignar: mostrar el codigo individual y no sincronizar.
            if (hb.status == "unclaimed") {
                Log.i(TAG, "[heartbeat] OK · sin asignar · codigo: ${hb.claimCode}")
                val p = org.json.JSONObject()
                    .put("status", "unclaimed")
                    .put("claimCode", hb.claimCode ?: "")
                SignageState.emit("pairing", p.toString())
                return false
            }

            // Vinculada pero el admin aun no configuro el layout: overlay de espera
            // y NO se pinta la grilla vacia por defecto.
            if (!hb.configured) {
                Log.i(TAG, "[heartbeat] OK · vinculada · esperando contenido")
                SignageState.emit("pairing", org.json.JSONObject().put("status", "waiting").toString())
                return false
            }

            // Activa: ocultar el overlay de vinculacion si estaba visible.
            SignageState.emit("pairing", "null")

            // El layout define las zonas/widgets; se reenvia al reproductor (la
            // descarga de medios sigue usando playlist/images).
            hb.layout?.let { SignageState.emit("layout", it) }

            // Lista vacía = "sin actualización": NO se borra lo local (igual que main.js).
            // Primero IMÁGENES (pequeñas, rápidas) y luego VIDEOS (grandes); el
            // reproductor solo muestra lo ya descargado, así que no hay conflicto.
            if (hb.images.isEmpty()) {
                Log.i(TAG, "[heartbeat] OK · imagenes vacias -> se conserva lo local")
            } else {
                val available = Sync.syncMedia(
                    hb.images, Config.imagesDir(this), Sync.imageRegex()
                ) { n -> "${cfg.serverUrl}/image/${enc(n)}?deviceId=${enc(cfg.deviceId)}" }
                SignageState.emit("images", JSONArray(available).toString())
                Log.i(TAG, "[sync] Imagenes disponibles: $available")
            }

            if (hb.playlist.isEmpty()) {
                Log.i(TAG, "[heartbeat] OK · videos vacios -> se conserva lo local")
            } else {
                Log.i(TAG, "[heartbeat] OK · videos: ${hb.playlist}")
                val available = Sync.syncMedia(
                    hb.playlist, Config.videosDir(this), Sync.videoRegex()
                ) { n -> "${cfg.serverUrl}/download/${enc(n)}?deviceId=${enc(cfg.deviceId)}" }
                SignageState.emit("playlist", JSONArray(available).toString())
                Log.i(TAG, "[sync] Videos disponibles: $available")
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "[heartbeat] FALLO - ${e.message} (se conserva el contenido local)")
            return false
        }
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    // ----------------------------- Notificación -----------------------------

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                CHANNEL_ID, getString(R.string.sync_channel_name),
                NotificationManager.IMPORTANCE_MIN
            )
            nm.createNotificationChannel(ch)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID) else
            @Suppress("DEPRECATION") Notification.Builder(this)
        return builder
            .setContentTitle(getString(R.string.sync_notification_title))
            .setContentText(getString(R.string.sync_notification_text))
            .setSmallIcon(R.drawable.ic_launcher)
            .setOngoing(true)
            .build()
    }
}
