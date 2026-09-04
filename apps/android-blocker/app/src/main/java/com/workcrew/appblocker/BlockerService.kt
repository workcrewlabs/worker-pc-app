package com.workcrew.appblocker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.Calendar

/**
 * Foreground service that polls "which app is on screen" every few seconds,
 * feeds a [WatchSession], and acts on its events: a full-screen overlay
 * reminder every N minutes, and a forced switch to the redirect app (or home
 * screen) once the limit is hit, repeated for as long as the lockout holds.
 *
 * It also owns the two pieces of self-control friction: enforcement only runs
 * inside the configured daily window, and a requested stop only takes effect
 * after the configured wait. Everything runs on-device; no network.
 */
class BlockerService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var tracker: ForegroundAppTracker
    private lateinit var overlay: OverlayReminder
    private lateinit var powerManager: PowerManager
    private var session: WatchSession? = null
    private var lastNotificationText: String? = null

    override fun onCreate() {
        super.onCreate()
        tracker = ForegroundAppTracker(
            getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        )
        overlay = OverlayReminder(this)
        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = Prefs(this)
        createChannel()
        // Starting fresh cancels any stop that was counting down.
        prefs.stopAllowedAtMs = 0L
        startForeground(
            NOTIFICATION_ID,
            buildNotification(
                getString(R.string.notification_text, prefs.watchedLabel, 0, prefs.limitMinutes)
            ),
        )

        // Re-reading settings here means pressing Start again applies changes.
        session = WatchSession(
            remindEveryMs = prefs.remindEveryMinutes * 60_000L,
            limitMs = prefs.limitMinutes * 60_000L,
            resetAfterAwayMs = RESET_AFTER_AWAY_MS,
            lockoutMs = prefs.lockoutMinutes * 60_000L,
        )
        lastNotificationText = null
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlay.dismiss()
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private val tick = object : Runnable {
        override fun run() {
            try {
                pollOnce()
            } catch (e: Exception) {
                // A single bad poll (e.g. usage access revoked) must not kill the
                // service loop.
                Log.w(TAG, "poll failed", e)
            }
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private fun pollOnce() {
        val session = session ?: return
        val prefs = Prefs(this)
        val now = System.currentTimeMillis()

        val stopAllowedAt = prefs.stopAllowedAtMs
        if (stopAllowedAt > 0L && now >= stopAllowedAt) {
            prefs.stopAllowedAtMs = 0L
            stopSelf()
            return
        }

        tracker.update(now)

        val inWindow = Schedule.isWithinWindow(
            minutesOfDay(), prefs.activeStartMinutes, prefs.activeEndMinutes
        )
        if (!inWindow) {
            // Off duty: drop all progress so the next window starts clean.
            session.onIdle(now)
            updateNotification(status(prefs, session, inWindow = false, stopAllowedAt, now))
            return
        }

        // Screen off doesn't count as watching, even if the app is still "resumed".
        val watching = powerManager.isInteractive && tracker.currentPackage == prefs.watchedPackage
        when (val event = session.onTick(now, watching)) {
            is WatchSession.Remind -> showReminder(prefs, event.watchedMs)
            is WatchSession.SwitchAway -> enforce(prefs, session, event)
            null -> Unit
        }
        updateNotification(status(prefs, session, inWindow = true, stopAllowedAt, now))
    }

    private fun showReminder(prefs: Prefs, watchedMs: Long) {
        val minutes = (watchedMs / 60_000L).toInt()
        overlay.show(
            title = getString(R.string.reminder_title),
            message = getString(
                R.string.reminder_message, prefs.watchedLabel, minutes, prefs.limitMinutes
            ),
            primaryLabel = getString(R.string.reminder_keep_watching),
            secondaryLabel = getString(R.string.reminder_take_break),
            onSecondary = { launchRedirect(prefs) },
            autoDismissMs = REMINDER_AUTO_DISMISS_MS,
        )
    }

    private fun enforce(prefs: Prefs, session: WatchSession, event: WatchSession.SwitchAway) {
        val target = prefs.redirectLabel ?: getString(R.string.home_screen)
        if (event.firstTime) {
            overlay.show(
                title = getString(R.string.limit_title),
                message = getString(
                    R.string.limit_message,
                    prefs.limitMinutes,
                    prefs.watchedLabel,
                    target,
                    prefs.lockoutMinutes,
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LIMIT_AUTO_DISMISS_MS,
            )
            // Small delay so the user sees why they are being moved.
            handler.postDelayed({ launchRedirect(prefs) }, SWITCH_DELAY_MS)
        } else {
            overlay.show(
                title = getString(R.string.locked_title),
                message = getString(
                    R.string.locked_message,
                    prefs.watchedLabel,
                    ceilMinutes(session.lockoutRemainingMs),
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LOCKED_AUTO_DISMISS_MS,
            )
            handler.postDelayed({ launchRedirect(prefs) }, LOCKED_SWITCH_DELAY_MS)
        }
    }

    private fun launchRedirect(prefs: Prefs) {
        val redirect = prefs.redirectPackage
            ?.let { packageManager.getLaunchIntentForPackage(it) }
            ?: homeIntent()
        redirect.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(redirect)
        } catch (e: Exception) {
            // Redirect app uninstalled or launch blocked — the home screen is
            // always a safe landing spot.
            Log.w(TAG, "redirect launch failed, falling back to home", e)
            try {
                startActivity(homeIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e2: Exception) {
                Log.w(TAG, "home launch failed", e2)
            }
        }
    }

    private fun homeIntent(): Intent =
        Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)

    private fun minutesOfDay(): Int = Calendar.getInstance().let {
        it.get(Calendar.HOUR_OF_DAY) * 60 + it.get(Calendar.MINUTE)
    }

    private fun status(
        prefs: Prefs,
        session: WatchSession,
        inWindow: Boolean,
        stopAllowedAtMs: Long,
        nowMs: Long,
    ): String {
        val core = when {
            !inWindow -> getString(
                R.string.notification_off_duty, Schedule.format(prefs.activeStartMinutes)
            )
            session.locked -> getString(
                R.string.notification_locked,
                prefs.watchedLabel,
                ceilMinutes(session.lockoutRemainingMs),
            )
            else -> getString(
                R.string.notification_text,
                prefs.watchedLabel,
                (session.watchedMs / 60_000L).toInt(),
                prefs.limitMinutes,
            )
        }
        if (stopAllowedAtMs <= 0L) return core
        return getString(R.string.notification_stopping, ceilMinutes(stopAllowedAtMs - nowMs)) +
            " · " + core
    }

    private fun ceilMinutes(ms: Long): Int =
        ((ms.coerceAtLeast(0L) + 59_999L) / 60_000L).toInt()

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): android.app.Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        if (text == lastNotificationText) return
        lastNotificationText = text
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        @Volatile
        var isRunning = false
            private set

        private const val TAG = "BlockerService"
        private const val CHANNEL_ID = "blocker_status"
        private const val NOTIFICATION_ID = 1

        private const val POLL_INTERVAL_MS = 5_000L
        private const val RESET_AFTER_AWAY_MS = 5L * 60 * 1000
        private const val SWITCH_DELAY_MS = 1_500L
        private const val LOCKED_SWITCH_DELAY_MS = 400L
        private const val REMINDER_AUTO_DISMISS_MS = 30_000L
        private const val LIMIT_AUTO_DISMISS_MS = 5_000L
        private const val LOCKED_AUTO_DISMISS_MS = 3_000L
    }
}
