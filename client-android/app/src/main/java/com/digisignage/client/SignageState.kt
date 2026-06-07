package com.digisignage.client

/**
 * Bus de estado en proceso entre el servicio de sincronización (productor) y la
 * MainActivity/WebView (consumidor). Sustituye al IPC de Electron.
 *
 * Guarda el último valor de cada canal para poder reenviarlo cuando la WebView
 * termina de cargar (paralelo a did-finish-load en main.js). El payload es la
 * cadena JSON ya serializada que se inyecta tal cual en window.__signage.<canal>(...).
 */
object SignageState {

    /** Canal -> último payload JSON conocido. */
    private val last = HashMap<String, String>()

    /** Suscriptor actual (la Activity). Recibe (canal, payloadJson). */
    @Volatile
    var listener: ((channel: String, payload: String) -> Unit)? = null

    @Synchronized
    fun emit(channel: String, payload: String) {
        last[channel] = payload
        listener?.invoke(channel, payload)
    }

    /** Reenvía todos los valores cacheados al suscriptor (al recargar la WebView). */
    @Synchronized
    fun replayTo(l: (channel: String, payload: String) -> Unit) {
        for ((channel, payload) in last) l(channel, payload)
    }
}
