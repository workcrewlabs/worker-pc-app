package com.workcrew.appblocker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fires on two of our own alarms, both answered the same way.
 *
 * The repeating watchdog restarts the service if something killed it — the case
 * `START_STICKY` does not cover, such as an OEM battery manager sleeping the
 * app overnight — and re-arms the next check. The one-shot resume alarm marks
 * the end of a stop the user set a return for; [BlockerLauncher.ensureRunning]
 * decides which of the two it is from what is stored, so a late or duplicate
 * alarm cannot turn blocking on early or twice.
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            BlockerLauncher.ACTION_WATCHDOG, BlockerLauncher.ACTION_RESUME ->
                BlockerLauncher.ensureRunning(context)
        }
    }
}
