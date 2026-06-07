package com.digisignage.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Autostart: al terminar el arranque del TV box, lanza la MainActivity para que el
 * cartel se reproduzca solo sin intervención. No tiene equivalente en Electron.
 *
 * Nota operativa: muchos TV box exigen abrir la app al menos una vez tras instalar
 * y/o habilitarla en su "gestor de autoarranque" propio para que este receiver
 * llegue a dispararse.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON"
        ) {
            val launch = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launch)
        }
    }
}
