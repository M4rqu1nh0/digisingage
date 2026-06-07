package com.digisignage.client

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Activity del reproductor: WebView a pantalla completa (kiosko) que carga
 * player.html y recibe los datos del SyncService vía SignageState.
 * Equivalente a createWindow() del cliente Electron (main.js).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var media: MediaRequestHandler
    private var rendererReady = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Pantalla siempre encendida (cartel desatendido 24/7).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        media = MediaRequestHandler(this, Config.videosDir(this), Config.imagesDir(this))

        webView = WebView(this)
        setContentView(webView)
        configureFullscreen()
        configureWebView()

        // Suscripción al bus: empuja cada actualización a la WebView en el hilo UI.
        SignageState.listener = { channel, payload ->
            runOnUiThread { if (rendererReady) pushToRenderer(channel, payload) }
        }

        webView.loadUrl(MediaRequestHandler.BASE + "player.html")

        // Arranca el servicio de sincronización en primer plano.
        val svc = Intent(this, SyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc)
        else startService(svc)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // autoplay sin interacción
            allowFileAccess = false                  // todo se sirve por el handler
            allowContentAccess = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? {
                if (request == null) return null
                return media.handle(request)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                rendererReady = true
                // Reenvía el último estado conocido al cargar el reproductor.
                SignageState.replayTo { channel, payload -> pushToRenderer(channel, payload) }
            }
        }
    }

    /** Inyecta el payload JSON en el canal correspondiente del reproductor. */
    private fun pushToRenderer(channel: String, payload: String) {
        webView.evaluateJavascript(
            "window.__signage && window.__signage.$channel($payload);", null
        )
    }

    private fun configureFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, webView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) configureFullscreen() // reaplica el modo inmersivo
    }

    override fun onDestroy() {
        SignageState.listener = null
        webView.destroy()
        super.onDestroy()
    }
}
