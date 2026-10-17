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
 * Foreground service that polls "which app is on screen" every few seconds and
 * feeds one [WatchSession] per limited app, acting on whatever each one asks
 * for: a full-screen overlay reminder every N minutes of use, and a forced
 * switch to that app's redirect target once its limit is hit, repeated for as
 * long as its lockout holds.
 *
 * Every app's rules are independent — its own window, reminder cadence, limit,
 * lockout and redirect — so only the app actually on screen accrues time, and
 * one app being locked says nothing about the others.
 *
 * It also owns the self-control friction: enforcement only runs inside each
 * app's configured window, and a requested stop only takes effect once the
 * longest of the apps' cancel waits is up. Everything runs on-device; no
 * network.
 */
class BlockerService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var tracker: ForegroundAppTracker
    private lateinit var overlay: OverlayReminder
    private lateinit var powerManager: PowerManager

    private var limits: List<AppLimit> = emptyList()
    private val sessions = mutableMapOf<String, WatchSession>()
    private val lastPersisted = mutableMapOf<String, Triple<Long, Boolean, Long>>()
    private var lastNotification: NotificationState? = null

    /** The notification as last shown, so re-asserting it can't flash new text. */
    private data class NotificationState(
        val text: String,
        val detail: String,
        val showLockNow: Boolean,
    )

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
        val lockNowRequested = intent?.action == ACTION_LOCK_NOW
        if (lockNowRequested && sessions.isNotEmpty()) {
            // Already running: just start the break, leaving the sessions alone.
            startForeground(NOTIFICATION_ID, currentNotification())
            startLockoutEarly(prefs)
            return START_STICKY
        }
        // A restart after a kill must not quietly cancel a stop the user asked
        // for; only pressing Start does that.
        val autoRestart = intent?.getBooleanExtra(EXTRA_AUTO_RESTART, false) == true
        if (!autoRestart && !lockNowRequested) prefs.stopAllowedAtMs = 0L
        // Remember the intent to block so a reboot or a kill can be recovered from.
        prefs.blockerEnabled = true
        BlockerLauncher.scheduleWatchdog(this)
        // Re-reading settings here means pressing Start again applies changes.
        limits = prefs.limits
        startForeground(
            NOTIFICATION_ID,
            buildNotification(freshStartText(), detail = "", showLockNow = false),
        )

        val now = System.currentTimeMillis()
        sessions.clear()
        lastPersisted.clear()
        limits.forEach { limit ->
            sessions[limit.packageName] = limit.newSession()
                .also { restoreSavedProgress(prefs, limit, it, now) }
        }
        lastNotification = null
        handler.removeCallbacks(tick)
        handler.post(tick)
        if (lockNowRequested) startLockoutEarly(prefs)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlay.dismiss()
        isRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app out of Recents kills the process on some phones; make
        // sure a watchdog check is pending before that happens.
        BlockerLauncher.scheduleWatchdog(this)
        super.onTaskRemoved(rootIntent)
    }

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
        val prefs = Prefs(this)
        val now = System.currentTimeMillis()

        val stopAllowedAt = prefs.stopAllowedAtMs
        val stopDue = stopAllowedAt > 0L && now >= stopAllowedAt
        // No rules left is the same as being stopped — a foreground service
        // with nothing to limit would just sit there holding a notification.
        if (stopDue || limits.isEmpty()) {
            // A stop the user waited out is the one case where the blocker is
            // meant to stay off, so clear the flag the watchdog restarts from.
            prefs.stopAllowedAtMs = 0L
            prefs.blockerEnabled = false
            BlockerLauncher.cancelWatchdog(this)
            stopSelf()
            return
        }

        tracker.update(now)
        // Screen off doesn't count as using an app, even if one is still "resumed".
        val foreground = tracker.currentPackage?.takeIf { powerManager.isInteractive }
        val minutesOfDay = minutesOfDay()

        // Only the app on screen can raise an event — time accrues for it
        // alone, and a lockout only bounces someone who just opened that app —
        // so at most one of these interrupts the screen per poll.
        limits.forEach { limit ->
            val session = sessions[limit.packageName] ?: return@forEach
            val inWindow = Schedule.isWithinWindow(
                minutesOfDay, limit.activeStartMinutes, limit.activeEndMinutes
            )
            if (!inWindow) {
                // Off duty: drop this app's progress so its next window starts clean.
                session.onIdle(now)
                prefs.clearSessionState(limit.packageName)
                lastPersisted.remove(limit.packageName)
                return@forEach
            }
            when (val event = session.onTick(now, foreground == limit.packageName)) {
                is WatchSession.Remind -> showReminder(limit, event.watchedMs)
                is WatchSession.SwitchAway -> enforce(limit, session, event, now)
                null -> Unit
            }
            persistProgress(prefs, limit, session, now)
        }

        renderNotification(prefs, foreground, minutesOfDay, stopAllowedAt, now)
    }

    /**
     * Progress from earlier in the same window is picked back up, so a service
     * restart — system kill, reboot, or a stop and start — cannot refund spent
     * budget. Progress from an earlier window of this app is dropped instead.
     */
    private fun restoreSavedProgress(
        prefs: Prefs,
        limit: AppLimit,
        session: WatchSession,
        nowMs: Long,
    ) {
        val saved = prefs.sessionState(limit.packageName) ?: return
        val windowStart = Schedule.currentWindowStartMs(
            nowMs, minutesOfDay(), limit.activeStartMinutes
        )
        if (saved.savedAtMs < windowStart || saved.savedAtMs > nowMs) {
            prefs.clearSessionState(limit.packageName)
            return
        }
        session.restore(nowMs, saved.watchedMs, saved.locked, saved.lockoutUntilMs)
    }

    private fun persistProgress(
        prefs: Prefs,
        limit: AppLimit,
        session: WatchSession,
        nowMs: Long,
    ) {
        val snapshot = Triple(session.watchedMs, session.locked, session.lockoutUntilMs)
        if (snapshot == lastPersisted[limit.packageName]) return
        lastPersisted[limit.packageName] = snapshot
        prefs.saveSessionState(
            limit.packageName, session.watchedMs, session.locked, session.lockoutUntilMs, nowMs
        )
    }

    private fun showReminder(limit: AppLimit, watchedMs: Long) {
        val minutes = (watchedMs / 60_000L).toInt()
        overlay.show(
            title = getString(R.string.reminder_title),
            message = getString(
                R.string.reminder_message, limit.label, minutes, limit.limitMinutes
            ),
            primaryLabel = getString(R.string.reminder_keep_watching),
            secondaryLabel = getString(R.string.reminder_take_break),
            onSecondary = { launchRedirect(limit) },
            autoDismissMs = REMINDER_AUTO_DISMISS_MS,
        )
    }

    private fun enforce(
        limit: AppLimit,
        session: WatchSession,
        event: WatchSession.SwitchAway,
        nowMs: Long,
    ) {
        val target = limit.redirectLabel ?: getString(R.string.home_screen)
        if (event.firstTime) {
            overlay.show(
                title = getString(R.string.limit_title),
                message = getString(
                    R.string.limit_message,
                    limit.limitMinutes,
                    limit.label,
                    target,
                    limit.lockoutMinutes,
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LIMIT_AUTO_DISMISS_MS,
            )
            // Small delay so the user sees why they are being moved.
            handler.postDelayed({ launchRedirect(limit) }, SWITCH_DELAY_MS)
        } else {
            overlay.show(
                title = getString(R.string.locked_title),
                message = getString(
                    R.string.locked_message,
                    limit.label,
                    ceilMinutes(session.lockoutRemainingMs(nowMs)),
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LOCKED_AUTO_DISMISS_MS,
            )
            handler.postDelayed({ launchRedirect(limit) }, LOCKED_SWITCH_DELAY_MS)
        }
    }

    /**
     * "Block now" from the notification: spend the rest of the budget and start
     * the lockout immediately, for when the user is done watching (or done
     * eating) early and would rather not leave unspent minutes tempting them.
     *
     * With several apps limited, pressing it while in one of them starts that
     * app's break only — the obvious reading of "I'm done with this". Pressed
     * from anywhere else it starts the break for every app currently on duty,
     * which is what the button means when it isn't about one app in particular.
     *
     * Apps that are off duty or already locked are skipped either way, so a
     * stray tap can never restart a wait that is already part-served.
     */
    private fun startLockoutEarly(prefs: Prefs) {
        val now = System.currentTimeMillis()
        val minutesOfDay = minutesOfDay()
        tracker.update(now)
        val foreground = tracker.currentPackage

        val eligible = limits.filter { lockNowEligible(it, minutesOfDay) }
        if (eligible.isEmpty()) return
        val inForeground = eligible.firstOrNull { it.packageName == foreground }
        val targets = inForeground?.let { listOf(it) } ?: eligible

        targets.forEach { limit ->
            val session = sessions[limit.packageName] ?: return@forEach
            session.lockNow(now)
            persistProgress(prefs, limit, session, now)
        }

        // Only interrupt the screen if they are actually in the app being
        // locked; pressing this from anywhere else should be a quiet
        // confirmation, and the updated notification in the shade is that.
        if (inForeground != null) {
            overlay.show(
                title = getString(R.string.lock_now_title),
                message = getString(
                    R.string.lock_now_message, inForeground.label, inForeground.lockoutMinutes
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LIMIT_AUTO_DISMISS_MS,
            )
            handler.postDelayed({ launchRedirect(inForeground) }, LOCKED_SWITCH_DELAY_MS)
        }
        renderNotification(prefs, foreground, minutesOfDay, prefs.stopAllowedAtMs, now)
    }

    private fun lockNowEligible(limit: AppLimit, minutesOfDay: Int): Boolean {
        val session = sessions[limit.packageName] ?: return false
        if (session.locked) return false
        return Schedule.isWithinWindow(
            minutesOfDay, limit.activeStartMinutes, limit.activeEndMinutes
        )
    }

    private fun launchRedirect(limit: AppLimit) {
        val redirect = limit.redirectPackage
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

    /**
     * One status line per limited app, with the one that matters most first:
     * an app being locked beats the app on screen, which beats one that has
     * started accruing time, which beats an idle or off-duty one. The leader
     * becomes the collapsed notification text and the rest fill out the
     * expanded view.
     */
    private fun renderNotification(
        prefs: Prefs,
        foreground: String?,
        minutesOfDay: Int,
        stopAllowedAtMs: Long,
        nowMs: Long,
    ) {
        val ranked = limits.mapNotNull { limit ->
            val session = sessions[limit.packageName] ?: return@mapNotNull null
            val inWindow = Schedule.isWithinWindow(
                minutesOfDay, limit.activeStartMinutes, limit.activeEndMinutes
            )
            val rank = when {
                session.locked -> 0
                limit.packageName == foreground -> 1
                !inWindow -> 4
                session.watchedMs > 0 -> 2
                else -> 3
            }
            Triple(rank, -session.watchedMs, statusLine(limit, session, inWindow, nowMs))
        }.sortedWith(compareBy({ it.first }, { it.second }))

        val lines = ranked.map { it.third }
        val headline = lines.firstOrNull() ?: getString(R.string.notification_idle)
        val text = if (stopAllowedAtMs <= 0L) {
            headline
        } else {
            getString(R.string.notification_stopping, ceilMinutes(stopAllowedAtMs - nowMs)) +
                " · " + headline
        }
        updateNotification(
            text = text,
            // A single app says everything in the collapsed line already.
            detail = if (lines.size > 1) lines.joinToString("\n") else "",
            showLockNow = limits.any { lockNowEligible(it, minutesOfDay) },
        )
    }

    private fun statusLine(
        limit: AppLimit,
        session: WatchSession,
        inWindow: Boolean,
        nowMs: Long,
    ): String = when {
        !inWindow -> getString(
            R.string.notification_off_duty,
            limit.label,
            Schedule.format(limit.activeStartMinutes),
        )
        session.locked -> getString(
            R.string.notification_locked,
            limit.label,
            ceilMinutes(session.lockoutRemainingMs(nowMs)),
        )
        else -> getString(
            R.string.notification_text,
            limit.label,
            (session.watchedMs / 60_000L).toInt(),
            limit.limitMinutes,
        )
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

    /**
     * [detail] is the per-app breakdown shown when the notification is
     * expanded, empty when the collapsed line already says it all.
     * [showLockNow] adds the "Block now" action — offered only while some app
     * still has budget left to give up, since during a lockout there is
     * nothing to start early.
     */
    private fun buildNotification(
        text: String,
        detail: String,
        showLockNow: Boolean,
    ): android.app.Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setContentIntent(openApp)
            .setOngoing(true)
        if (detail.isNotEmpty()) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(detail))
        }
        if (showLockNow) {
            val lockNow = PendingIntent.getForegroundService(
                this,
                REQUEST_LOCK_NOW,
                Intent(this, BlockerService::class.java).setAction(ACTION_LOCK_NOW),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_notification,
                    getString(R.string.notification_lock_now),
                    lockNow,
                ).build()
            )
        }
        return builder.build()
    }

    /**
     * The notification as last shown, for re-asserting foreground state without
     * flashing different text at the user. Falls back to the fresh-start text if
     * nothing has been shown yet.
     */
    private fun currentNotification(): android.app.Notification {
        val last = lastNotification
            ?: NotificationState(freshStartText(), detail = "", showLockNow = false)
        return buildNotification(last.text, last.detail, last.showLockNow)
    }

    private fun freshStartText(): String {
        val first = limits.firstOrNull() ?: return getString(R.string.notification_idle)
        return getString(R.string.notification_text, first.label, 0, first.limitMinutes)
    }

    private fun updateNotification(text: String, detail: String, showLockNow: Boolean) {
        val next = NotificationState(text, detail, showLockNow)
        if (next == lastNotification) return
        lastNotification = next
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text, detail, showLockNow))
    }

    companion object {
        @Volatile
        var isRunning = false
            private set

        /** Marks a start that recovers from a kill rather than a user pressing Start. */
        const val EXTRA_AUTO_RESTART = "auto_restart"

        /** Notification action: spend the remaining budget and start the break now. */
        const val ACTION_LOCK_NOW = "com.workcrew.appblocker.action.LOCK_NOW"

        private const val TAG = "BlockerService"
        private const val CHANNEL_ID = "blocker_status"
        private const val NOTIFICATION_ID = 1
        private const val REQUEST_LOCK_NOW = 1

        private const val POLL_INTERVAL_MS = 5_000L
        private const val SWITCH_DELAY_MS = 1_500L
        private const val LOCKED_SWITCH_DELAY_MS = 400L
        private const val REMINDER_AUTO_DISMISS_MS = 30_000L
        private const val LIMIT_AUTO_DISMISS_MS = 5_000L
        private const val LOCKED_AUTO_DISMISS_MS = 3_000L
    }
}
