package com.digisignage.client

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Clima vía Open-Meteo (sin clave). Port de resolveLocation()/fetchWeather()
 * del cliente Electron (client/main.js). Produce un JSONObject con la misma forma
 * que consume applyWeather() en player.html.
 */
class Weather(private val cfg: WeatherCfg) {
    private val TAG = "DigiWeather"

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private data class Coords(val lat: Double, val lon: Double, val city: String)
    private var resolved: Coords? = null

    private fun getJson(url: String): JSONObject {
        val req = Request.Builder().url(url).get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw RuntimeException("HTTP ${res.code}")
            return JSONObject(res.body?.string().orEmpty())
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** Resuelve lat/lon desde config o geocodificando el nombre de la ciudad. */
    private fun resolveLocation() {
        if (cfg.lat != null && cfg.lon != null) {
            resolved = Coords(cfg.lat, cfg.lon, cfg.city)
            return
        }
        val parts = cfg.city.split(",").map { it.trim() }
        val name = parts.getOrNull(0).orEmpty()
        val countryHint = parts.getOrNull(1)?.lowercase().orEmpty()
        if (name.isBlank()) return
        try {
            val g = getJson(
                "https://geocoding-api.open-meteo.com/v1/search?name=${enc(name)}&count=5&language=es&format=json"
            )
            val results = g.optJSONArray("results") ?: return
            var r = if (results.length() > 0) results.getJSONObject(0) else return
            if (countryHint.isNotBlank()) {
                for (i in 0 until results.length()) {
                    val x = results.getJSONObject(i)
                    if (x.optString("country").lowercase().contains(countryHint)) { r = x; break }
                }
            }
            resolved = Coords(r.getDouble("latitude"), r.getDouble("longitude"),
                cfg.city.ifBlank { r.optString("name") })
            Log.i(TAG, "[weather] ubicacion: ${r.optString("name")} ${r.optString("country")}")
        } catch (e: Exception) {
            Log.w(TAG, "[weather] geocoding fallo - ${e.message}")
        }
    }

    /**
     * Consulta el clima actual. Devuelve el JSON listo para la WebView, o null si
     * no hay ubicación configurada o la consulta falla.
     */
    fun fetch(): JSONObject? {
        if (resolved == null) resolveLocation()
        val c = resolved ?: return null
        val url = "https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}" +
            "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day" +
            "&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto"
        return try {
            val j = getJson(url)
            val cur = j.optJSONObject("current") ?: JSONObject()
            val daily = j.optJSONObject("daily") ?: JSONObject()
            val maxArr = daily.optJSONArray("temperature_2m_max")
            val minArr = daily.optJSONArray("temperature_2m_min")
            JSONObject().apply {
                put("city", c.city)
                put("temp", cur.optDouble("temperature_2m").roundToInt())
                put("code", cur.optInt("weather_code"))
                put("isDay", cur.optInt("is_day") == 1)
                put("humidity", cur.optDouble("relative_humidity_2m").roundToInt())
                put("wind", cur.optDouble("wind_speed_10m").roundToInt())
                put("max", if (maxArr != null && maxArr.length() > 0) maxArr.getDouble(0).roundToInt() else JSONObject.NULL)
                put("min", if (minArr != null && minArr.length() > 0) minArr.getDouble(0).roundToInt() else JSONObject.NULL)
            }.also { Log.i(TAG, "[weather] OK $it") }
        } catch (e: Exception) {
            Log.w(TAG, "[weather] FALLO - ${e.message}")
            null
        }
    }
}
