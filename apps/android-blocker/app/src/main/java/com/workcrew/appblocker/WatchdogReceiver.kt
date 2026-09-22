package com.workcrew.appblocker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fires on the repeating watchdog alarm and restarts the service if something
 * killed it — the case `START_STICKY` does not cover, such as an OEM battery
 * manager sleeping the app overnight. Also re-arms the next check.
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != BlockerLauncher.ACTION_WATCHDOG) return
        BlockerLauncher.ensureRunning(context)
    }
}
