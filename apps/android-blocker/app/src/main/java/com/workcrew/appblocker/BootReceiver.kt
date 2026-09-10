package com.workcrew.appblocker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the blocker back after the phone restarts or the app is updated —
 * without this, a reboot silently leaves the phone unguarded until the user
 * notices and presses Start again.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED ->
                BlockerLauncher.ensureRunning(context)
        }
    }
}
