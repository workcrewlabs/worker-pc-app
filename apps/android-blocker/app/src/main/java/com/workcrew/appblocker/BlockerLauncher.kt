package com.workcrew.appblocker

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Keeps the blocker alive across everything that can kill it: a reboot, an app
 * update, the system reclaiming memory, and OEM battery managers that put idle
 * apps to sleep overnight. `START_STICKY` alone does not cover those — a
 * force-stop-style kill is never restarted by the system — so the intent to
 * block is stored in [Prefs.blockerEnabled] and re-asserted from three places:
 * the boot/update receiver, a repeating watchdog alarm, and the setup screen
 * opening.
 */
object BlockerLauncher {

    private const val TAG = "BlockerLauncher"
    const val ACTION_WATCHDOG = "com.workcrew.appblocker.action.WATCHDOG"

    /**
     * How often the watchdog checks. Doze holds inexact alarms to roughly this
     * cadence anyway, and it is short enough that a kill costs minutes of
     * unguarded time rather than a whole night.
     */
    private const val WATCHDOG_INTERVAL_MS = 15L * 60 * 1000

    /**
     * Start the service if the user wants blocking on and it isn't running, and
     * make sure the next watchdog check is armed either way. Safe to call from a
     * receiver, an alarm, or the UI.
     */
    fun ensureRunning(context: Context) {
        val prefs = Prefs(context)
        if (!prefs.blockerEnabled) {
            cancelWatchdog(context)
            return
        }
        if (!BlockerService.isRunning) {
            val intent = Intent(context, BlockerService::class.java)
                .putExtra(BlockerService.EXTRA_AUTO_RESTART, true)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // Android 12+ can refuse a background foreground-service start.
                // Holding "display over other apps" exempts this app, but a
                // refusal must not crash the receiver — the next watchdog tick
                // and the next time the user opens the app both retry.
                Log.w(TAG, "could not restart the blocker", e)
            }
        }
        scheduleWatchdog(context)
    }

    fun scheduleWatchdog(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Inexact but allowed to fire in Doze, so it needs no exact-alarm
        // permission and still wakes the phone overnight.
        alarms.setAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + WATCHDOG_INTERVAL_MS,
            watchdogIntent(context),
        )
    }

    fun cancelWatchdog(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarms.cancel(watchdogIntent(context))
    }

    private fun watchdogIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, WatchdogReceiver::class.java).setAction(ACTION_WATCHDOG),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
