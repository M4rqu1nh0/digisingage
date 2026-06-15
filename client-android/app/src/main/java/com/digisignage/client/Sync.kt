package com.digisignage.client

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Sincronización con el servidor: heartbeat + descarga/borrado de medios.
 * Port directo de tick()/syncMedia()/downloadTo()/nameFrom() del cliente Electron
 * (client/main.js). OkHttp sigue redirecciones 30x automáticamente.
 */
object Sync {
    private const val TAG = "DigiSync"

    private val VIDEO_RE = Regex("\\.(mp4|webm|ogg|mov|mkv)$", RegexOption.IGNORE_CASE)
    private val IMAGE_RE = Regex("\\.(jpe?g|png|gif|webp|bmp)$", RegexOption.IGNORE_CASE)

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS) // sin tope global (descargas grandes)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /**
     * Resultado del heartbeat: estado de asignacion, listas a sincronizar y el
     * layout crudo (JSON). Si status == "unclaimed", la pantalla aun no esta
     * vinculada y `claimCode` trae el codigo individual a mostrar.
     */
    data class Heartbeat(
        val status: String,
        val claimCode: String?,
        val playlist: List<String>,
        val images: List<String>,
        val layout: String?,
    )

    /** POST /api/heartbeat -> { status, claimCode?, layout, playlist[], images[] }. Lanza si falla. */
    fun heartbeat(serverUrl: String, deviceId: String, deviceName: String): Heartbeat {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("nombre", deviceName)
            .toString()
            .toRequestBody(JSON)

        val req = Request.Builder()
            .url("$serverUrl/api/heartbeat")
            .post(body)
            .build()

        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw RuntimeException("HTTP ${res.code}")
            val json = JSONObject(res.body?.string().orEmpty())
            return Heartbeat(
                status = json.optString("status", "ok"),
                claimCode = if (json.isNull("claimCode")) null else json.optString("claimCode").ifBlank { null },
                playlist = toStringList(json.optJSONArray("playlist")),
                images = toStringList(json.optJSONArray("images")),
                layout = json.optJSONObject("layout")?.toString(),
            )
        }
    }

    private fun toStringList(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
    }

    /** Nombre de archivo a partir de un item que puede ser nombre o URL absoluta. */
    private fun nameFrom(item: String): String =
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(item))
            File(URI(item).path).name
        else item

    private fun localFiles(dir: File, re: Regex): List<String> =
        dir.listFiles()?.map { it.name }?.filter { re.containsMatchIn(it) } ?: emptyList()

    /** Descarga a <dest>.part y renombra al terminar (atómico). */
    private fun downloadTo(url: String, dest: File) {
        val req = Request.Builder().url(url).get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw RuntimeException("HTTP ${res.code}")
            val tmp = File(dest.parentFile, dest.name + ".part")
            res.body!!.byteStream().use { input ->
                tmp.outputStream().use { out -> input.copyTo(out, 64 * 1024) }
            }
            if (!tmp.renameTo(dest)) {
                tmp.copyTo(dest, overwrite = true); tmp.delete()
            }
        }
    }

    /**
     * Sincroniza una carpeta con una lista de medios: descarga los que falten,
     * borra los sobrantes. Devuelve los nombres realmente disponibles, en el orden
     * de la lista (respeta repeticiones). Paralelo a syncMedia() de main.js.
     */
    fun syncMedia(items: List<String>, dir: File, re: Regex, urlFor: (String) -> String): List<String> {
        val desired = items.map { nameFrom(it) }
        val present = localFiles(dir, re).toMutableSet()

        for (item in items) {
            val filename = nameFrom(item)
            if (!present.contains(filename)) {
                val url = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(item))
                    item else urlFor(item)
                try {
                    Log.i(TAG, "[download] Bajando $filename")
                    downloadTo(url, File(dir, filename))
                    present.add(filename)
                } catch (e: Exception) {
                    Log.w(TAG, "[download] ERROR con $filename - ${e.message}")
                }
            }
        }

        val desiredSet = desired.toSet()
        for (file in localFiles(dir, re)) {
            if (!desiredSet.contains(file)) {
                if (File(dir, file).delete()) Log.i(TAG, "[cleanup] Borrado $file")
                else Log.w(TAG, "[cleanup] No se pudo borrar $file")
            }
        }

        val finalAvailable = localFiles(dir, re).toSet()
        return desired.filter { finalAvailable.contains(it) }
    }

    fun videoRegex() = VIDEO_RE
    fun imageRegex() = IMAGE_RE
}
