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

    /** Fires once, at the instant a stopped blocker is due back on. */
    const val ACTION_RESUME = "com.workcrew.appblocker.action.RESUME"

    private const val REQUEST_WATCHDOG = 0
    private const val REQUEST_RESUME = 1

    /**
     * How often the watchdog checks. Doze holds inexact alarms to roughly this
     * cadence anyway, and it is short enough that a kill costs minutes of
     * unguarded time rather than a whole night.
     */
    private const val WATCHDOG_INTERVAL_MS = 15L * 60 * 1000

    /**
     * Start the service if blocking is meant to be on and it isn't running, and
     * make sure the next watchdog check is armed either way. Safe to call from a
     * receiver, an alarm, or the UI.
     *
     * Also the one place a scheduled return is honoured: once the wait is up
     * this turns blocking back on, and while it is still running this keeps the
     * alarm armed, since alarms do not survive a reboot.
     */
    fun ensureRunning(context: Context) {
        val prefs = Prefs(context)
        val now = System.currentTimeMillis()
        when (AutoResume.stateOf(prefs.blockerEnabled, prefs.resumeAtMs, now)) {
            AutoResume.State.OFF -> {
                cancelWatchdog(context)
                cancelResume(context)
                return
            }
            AutoResume.State.WAITING -> {
                cancelWatchdog(context)
                // Re-arming on every check is what carries the return across a
                // reboot, which clears the alarm but not the stored deadline.
                scheduleResume(context, prefs.resumeAtMs)
                return
            }
            AutoResume.State.RESUME_NOW -> {
                prefs.resumeAtMs = 0L
                cancelResume(context)
                prefs.blockerEnabled = true
            }
            AutoResume.State.RUNNING -> Unit
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

    /**
     * Record a stop that has just taken effect: clear the intent to block, drop
     * the watchdog, and arm the automatic return if the user has set one. Both
     * stop paths — the service finishing a waited-out stop, and the setup
     * screen stopping with no wait — go through here so neither can forget the
     * return.
     */
    fun recordStop(context: Context, nowMs: Long) {
        val prefs = Prefs(context)
        prefs.stopAllowedAtMs = 0L
        prefs.blockerEnabled = false
        cancelWatchdog(context)
        val resumeAt = AutoResume.deadlineFor(nowMs, prefs.autoResumeMinutes)
        prefs.resumeAtMs = resumeAt
        if (resumeAt > 0L) scheduleResume(context, resumeAt) else cancelResume(context)
    }

    /** A manual start supersedes any pending return. */
    fun clearPendingResume(context: Context) {
        Prefs(context).resumeAtMs = 0L
        cancelResume(context)
    }

    fun scheduleResume(context: Context, atMs: Long) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Inexact but Doze-permitted, like the watchdog: the return can be a few
        // minutes late, which is fine, but it must not wait for the phone to be
        // picked up.
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, resumeIntent(context))
    }

    fun cancelResume(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarms.cancel(resumeIntent(context))
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

    private fun watchdogIntent(context: Context): PendingIntent = alarmIntent(
        context, REQUEST_WATCHDOG, ACTION_WATCHDOG
    )

    private fun resumeIntent(context: Context): PendingIntent = alarmIntent(
        context, REQUEST_RESUME, ACTION_RESUME
    )

    // Distinct request codes, or the two alarms would replace each other.
    private fun alarmIntent(context: Context, requestCode: Int, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, WatchdogReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
