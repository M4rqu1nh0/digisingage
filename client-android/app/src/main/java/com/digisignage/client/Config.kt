package com.digisignage.client

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Configuración del cliente. Equivalente a loadConfig() del cliente Electron (main.js).
 *
 * Se persiste en config.json dentro de getExternalFilesDir(null), es decir
 * /Android/data/com.digisignage.client/files/config.json, de modo que se puede
 * editar por USB/explorador sin recompilar. En el primer arranque se crea desde
 * una plantilla y se autogenera un deviceId único y estable por equipo.
 */
data class WeatherCfg(val lat: Double?, val lon: Double?, val city: String)

data class Config(
    val serverUrl: String,
    val deviceId: String,
    val deviceName: String,
    val heartbeatSeconds: Int,
    val imageSeconds: Int,
    val weather: WeatherCfg,
) {
    companion object {
        const val DEFAULT_SERVER = "https://digisingage.onrender.com"

        /** Carpeta base de datos (videos/, images/, config.json). */
        fun baseDir(ctx: Context): File =
            ctx.getExternalFilesDir(null) ?: ctx.filesDir

        fun videosDir(ctx: Context): File = File(baseDir(ctx), "videos").apply { mkdirs() }
        fun imagesDir(ctx: Context): File = File(baseDir(ctx), "images").apply { mkdirs() }
        private fun configFile(ctx: Context): File = File(baseDir(ctx), "config.json")

        /**
         * Lee config.json (creándolo desde plantilla si falta) y garantiza un
         * deviceId persistente. Cualquier campo ausente cae a un valor por defecto.
         */
        fun load(ctx: Context): Config {
            videosDir(ctx); imagesDir(ctx)
            val file = configFile(ctx)

            var json = if (file.exists()) {
                runCatching { JSONObject(file.readText()) }.getOrElse { JSONObject() }
            } else {
                template().also { file.writeText(it.toString(2)) }
            }

            // deviceId estable y único por equipo (clave para diferenciar pantallas).
            if (json.optString("deviceId").isBlank()) {
                json = JSONObject(json.toString()).put("deviceId", UUID.randomUUID().toString())
                file.writeText(json.toString(2))
            }

            val wx = json.optJSONObject("weather") ?: JSONObject()
            return Config(
                serverUrl = json.optString("serverUrl", DEFAULT_SERVER)
                    .trim().trimEnd('/'),
                deviceId = json.optString("deviceId"),
                deviceName = json.optString("deviceName").ifBlank { Build.MODEL ?: "android-tv" },
                heartbeatSeconds = json.optInt("heartbeatSeconds", 60).coerceAtLeast(10),
                imageSeconds = json.optInt("imageSeconds", 6).coerceAtLeast(1),
                weather = WeatherCfg(
                    lat = if (wx.has("lat") && !wx.isNull("lat")) wx.optDouble("lat") else null,
                    lon = if (wx.has("lon") && !wx.isNull("lon")) wx.optDouble("lon") else null,
                    city = wx.optString("city", ""),
                ),
            )
        }

        private fun template(): JSONObject = JSONObject().apply {
            put("serverUrl", DEFAULT_SERVER)
            put("deviceName", "CAMBIAR-nombre-del-dispositivo")
            put("heartbeatSeconds", 60)
            put("imageSeconds", 6)
            put("weather", JSONObject().apply {
                put("lat", JSONObject.NULL)
                put("lon", JSONObject.NULL)
                put("city", "Valparaíso, Chile")
            })
        }
    }
}
