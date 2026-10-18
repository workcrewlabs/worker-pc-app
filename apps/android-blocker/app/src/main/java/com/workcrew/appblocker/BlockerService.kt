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

    private var engine: BlockerEngine? = null
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
        if (lockNowRequested && engine != null) {
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
        val started = BlockerEngine(prefs.limits)
        engine = started
        startForeground(
            NOTIFICATION_ID,
            buildNotification(freshStartText(), detail = "", showLockNow = false),
        )

        val now = System.currentTimeMillis()
        lastPersisted.clear()
        started.limits.forEach { limit ->
            started.sessionFor(limit.packageName)?.let { restoreSavedProgress(prefs, limit, it, now) }
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
        val engine = engine ?: return
        val now = System.currentTimeMillis()

        val stopAllowedAt = prefs.stopAllowedAtMs
        val stopDue = stopAllowedAt > 0L && now >= stopAllowedAt
        // No rules left is the same as being stopped — a foreground service
        // with nothing to limit would just sit there holding a notification.
        if (stopDue || engine.limits.isEmpty()) {
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

        engine.poll(now, minutesOfDay, foreground).forEach { outcome ->
            when (outcome) {
                is BlockerEngine.Remind ->
                    showReminder(outcome.limit, outcome.watchedMs, minutesOfDay)
                is BlockerEngine.SwitchAway ->
                    enforce(outcome.limit, outcome.firstTime, now, minutesOfDay)
                // Off duty: drop that app's progress so its next window starts clean.
                is BlockerEngine.OffDuty -> {
                    prefs.clearSessionState(outcome.limit.packageName)
                    lastPersisted.remove(outcome.limit.packageName)
                }
            }
        }
        engine.limits.forEach { limit ->
            if (engine.isOnDuty(limit, minutesOfDay)) persistProgress(prefs, limit, now)
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

    private fun persistProgress(prefs: Prefs, limit: AppLimit, nowMs: Long) {
        val session = engine?.sessionFor(limit.packageName) ?: return
        val snapshot = Triple(session.watchedMs, session.locked, session.lockoutUntilMs)
        if (snapshot == lastPersisted[limit.packageName]) return
        lastPersisted[limit.packageName] = snapshot
        prefs.saveSessionState(
            limit.packageName, session.watchedMs, session.locked, session.lockoutUntilMs, nowMs
        )
    }

    private fun showReminder(limit: AppLimit, watchedMs: Long, minutesOfDay: Int) {
        val minutes = (watchedMs / 60_000L).toInt()
        overlay.show(
            title = getString(R.string.reminder_title),
            message = getString(
                R.string.reminder_message, limit.label, minutes, limit.limitMinutes
            ),
            primaryLabel = getString(R.string.reminder_keep_watching),
            secondaryLabel = getString(R.string.reminder_take_break),
            onSecondary = { launchRedirect(limit, minutesOfDay) },
            autoDismissMs = REMINDER_AUTO_DISMISS_MS,
        )
    }

    private fun enforce(
        limit: AppLimit,
        firstTime: Boolean,
        nowMs: Long,
        minutesOfDay: Int,
    ) {
        val session = engine?.sessionFor(limit.packageName) ?: return
        val target = redirectLabelFor(limit, nowMs, minutesOfDay)
        if (firstTime) {
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
            handler.postDelayed({ launchRedirect(limit, minutesOfDay) }, SWITCH_DELAY_MS)
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
            handler.postDelayed({ launchRedirect(limit, minutesOfDay) }, LOCKED_SWITCH_DELAY_MS)
        }
    }

    /**
     * "Block now" from the notification: spend the rest of one app's budget and
     * start its lock immediately, for when the user is done watching (or done
     * eating) early and would rather not leave unspent minutes tempting them.
     *
     * It starts a break for exactly one app — the limited app on screen, or
     * failing that the one most recently on screen, which is what "I've just
     * finished with that" means when the button is pressed from the home
     * screen. The apps are separate, so a tap meant for one must never spend
     * the budget of the others.
     *
     * Does nothing when that app is off duty or already locked, so a stray tap
     * can neither restart a wait that is part-served nor lock something out of
     * hours.
     */
    private fun startLockoutEarly(prefs: Prefs) {
        val engine = engine ?: return
        val now = System.currentTimeMillis()
        val minutesOfDay = minutesOfDay()
        tracker.update(now)
        val foreground = tracker.currentPackage

        val target = engine.lockNowTarget(minutesOfDay, foreground) ?: return
        engine.lockNow(target, now)
        persistProgress(prefs, target, now)

        // Only interrupt the screen if they are actually in the app being
        // locked; pressing this from anywhere else should be a quiet
        // confirmation, and the updated notification in the shade is that.
        if (target.packageName == foreground) {
            overlay.show(
                title = getString(R.string.lock_now_title),
                message = getString(
                    R.string.lock_now_message, target.label, target.lockoutMinutes
                ),
                primaryLabel = getString(R.string.limit_ok),
                autoDismissMs = LIMIT_AUTO_DISMISS_MS,
            )
            handler.postDelayed({ launchRedirect(target, minutesOfDay) }, LOCKED_SWITCH_DELAY_MS)
        }
        renderNotification(prefs, foreground, minutesOfDay, prefs.stopAllowedAtMs, now)
    }

    /**
     * Sends the user where [limit] says to — except into an app that is itself
     * locked right now, which the engine substitutes the home screen for.
     */
    private fun launchRedirect(limit: AppLimit, minutesOfDay: Int) {
        val now = System.currentTimeMillis()
        val redirect = engine?.redirectFor(limit, now, minutesOfDay)
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
        val engine = engine ?: return
        val lines = engine.byRelevance(minutesOfDay, foreground).mapNotNull { limit ->
            val session = engine.sessionFor(limit.packageName) ?: return@mapNotNull null
            statusLine(limit, session, engine.isOnDuty(limit, minutesOfDay), nowMs)
        }
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
            showLockNow = engine.lockNowTarget(minutesOfDay, foreground) != null,
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

    /**
     * The name of where [limit] will actually send them, which is the home
     * screen when its own target is an app that is locked right now.
     */
    private fun redirectLabelFor(limit: AppLimit, nowMs: Long, minutesOfDay: Int): String {
        val target = engine?.redirectFor(limit, nowMs, minutesOfDay)
        return if (target == null) getString(R.string.home_screen)
        else limit.redirectLabel ?: target
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
        val first = engine?.limits?.firstOrNull()
            ?: return getString(R.string.notification_idle)
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
