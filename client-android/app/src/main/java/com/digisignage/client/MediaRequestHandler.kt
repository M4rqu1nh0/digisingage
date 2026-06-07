package com.digisignage.client

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * Sirve, bajo un único origen sintético (https://appassets.local/), tanto la
 * página del reproductor (desde assets) como los medios locales descargados.
 * Reemplaza los protocolos media:// e img:// del cliente Electron.
 *
 * Soporta peticiones por rango (Range) devolviendo 206 Partial Content, necesario
 * para que el elemento <video> reproduzca y busque de forma fiable (equivalente a
 * stream:true del esquema media:// en Electron).
 */
class MediaRequestHandler(
    private val ctx: Context,
    private val videosDir: File,
    private val imagesDir: File,
) {
    companion object {
        const val HOST = "appassets.local"
        const val BASE = "https://appassets.local/"
    }

    fun handle(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!url.host.equals(HOST, ignoreCase = true)) return null

        val segments = url.pathSegments
        if (segments.isEmpty()) return null

        return when (segments[0]) {
            "media" -> serveFile(File(videosDir, safeName(segments)), request)
            "img" -> serveFile(File(imagesDir, safeName(segments)), request)
            else -> serveAsset(url.path?.trimStart('/') ?: "")
        }
    }

    /** Toma el último segmento (basename) para evitar path traversal. */
    private fun safeName(segments: List<String>): String =
        File(segments.last()).name

    private fun serveAsset(path: String): WebResourceResponse? = try {
        val p = if (path.isBlank()) "player.html" else path
        val stream = ctx.assets.open(p)
        WebResourceResponse(mimeOf(p), "UTF-8", stream)
    } catch (e: Exception) {
        null
    }

    private fun serveFile(file: File, request: WebResourceRequest): WebResourceResponse {
        if (!file.exists() || !file.isFile) {
            return WebResourceResponse(null, null, 404, "Not Found", emptyMap(), null)
        }
        val mime = mimeOf(file.name)
        val total = file.length()
        val range = request.requestHeaders["Range"] ?: request.requestHeaders["range"]

        if (range == null) {
            val headers = mapOf("Accept-Ranges" to "bytes", "Content-Length" to total.toString())
            return WebResourceResponse(mime, null, 200, "OK", headers, FileInputStream(file))
        }

        // Range: bytes=start-end (end opcional).
        val m = Regex("bytes=(\\d*)-(\\d*)").find(range)
        var start = m?.groupValues?.get(1)?.toLongOrNull() ?: 0L
        var end = m?.groupValues?.get(2)?.toLongOrNull() ?: (total - 1)
        if (start < 0) start = 0
        if (end > total - 1) end = total - 1
        if (start > end) start = 0

        val length = end - start + 1
        val stream: InputStream = FileInputStream(file).apply {
            var toSkip = start
            while (toSkip > 0) {
                val skipped = skip(toSkip)
                if (skipped <= 0) break
                toSkip -= skipped
            }
        }
        val headers = mapOf(
            "Accept-Ranges" to "bytes",
            "Content-Range" to "bytes $start-$end/$total",
            "Content-Length" to length.toString(),
        )
        return WebResourceResponse(
            mime, null, 206, "Partial Content", headers,
            LimitedInputStream(stream, length),
        )
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "ogg", "ogv" -> "video/ogg"
        "mov" -> "video/quicktime"
        "mkv" -> "video/x-matroska"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "html", "htm" -> "text/html"
        "js" -> "application/javascript"
        "css" -> "text/css"
        else -> "application/octet-stream"
    }

    /** InputStream que corta la lectura tras N bytes (para respuestas por rango). */
    private class LimitedInputStream(
        private val src: InputStream,
        private var remaining: Long,
    ) : InputStream() {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = src.read()
            if (b >= 0) remaining--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (remaining <= 0) return -1
            val toRead = minOf(len.toLong(), remaining).toInt()
            val n = src.read(b, off, toRead)
            if (n > 0) remaining -= n
            return n
        }

        override fun close() = src.close()
    }
}
