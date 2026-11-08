package com.workcrew.appblocker

/**
 * Pure time-accounting state machine for one watched app. The service feeds it a
 * tick every few seconds saying whether the watched app is on screen, and it
 * answers with the event (if any) the service should act on:
 *
 *  - [Remind] every `remindEveryMs` of accumulated watching (e.g. at 10, then 20
 *    minutes) so the service can interrupt the screen with a reminder.
 *  - [SwitchAway] once accumulated watching reaches `limitMs`, and then again
 *    every time the user re-opens the watched app while the lockout holds.
 *
 * The limit is a **total for the whole active window**: time away never refunds
 * budget, so five minutes now and five minutes an hour later still add up. The
 * only ways the budget comes back are the lockout ending, or the active window
 * ending (see [onIdle]).
 *
 * Reaching the limit starts that lockout, which runs to a fixed deadline. Trying
 * to open the app during it is bounced but does **not** push the deadline back —
 * the user is thrown out within a second, so counting that as "went back to
 * watching" would punish a stray tap with the whole wait over again.
 *
 * Kept free of Android imports so it is unit-testable on the JVM.
 */
class WatchSession(
    private val remindEveryMs: Long,
    private val limitMs: Long,
    private val lockoutMs: Long,
) {
    sealed interface Event
    data class Remind(val watchedMs: Long) : Event

    /**
     * Push the user out of the watched app. [firstTime] marks the moment the
     * lockout began (a "time's up" interruption) as opposed to the repeat
     * pushes that keep them out for the rest of it.
     */
    data class SwitchAway(val watchedMs: Long, val firstTime: Boolean) : Event

    var watchedMs: Long = 0
        private set

    /** True while the watched app is off-limits and every entry is bounced. */
    var locked: Boolean = false
        private set

    /**
     * Wall-clock instant the lockout lifts, or 0 when not locked. Absolute, so
     * that bounced entries cannot extend it and a restart cannot lose track of
     * how much of the wait has already been served.
     */
    var lockoutUntilMs: Long = 0
        private set

    private var lastTickAtMs = 0L
    private var nextRemindAtMs = remindEveryMs
    private var lastSwitchAtMs = 0L

    /** How much of the lockout is still owed at [nowMs]; 0 when not locked. */
    fun lockoutRemainingMs(nowMs: Long): Long =
        if (!locked) 0 else (lockoutUntilMs - nowMs).coerceAtLeast(0)

    fun onTick(nowMs: Long, watchedAppInForeground: Boolean): Event? {
        // Cap the credit per tick so a device that slept between ticks doesn't
        // get hours of watching charged in one jump.
        val elapsedMs =
            if (lastTickAtMs == 0L) 0L
            else (nowMs - lastTickAtMs).coerceIn(0L, MAX_CREDIT_PER_TICK_MS)
        lastTickAtMs = nowMs

        if (locked) return tickLocked(nowMs, watchedAppInForeground)
        if (!watchedAppInForeground) return null

        watchedMs += elapsedMs

        if (watchedMs >= limitMs) return lock(nowMs, firstTime = true)
        if (watchedMs >= nextRemindAtMs) {
            nextRemindAtMs += remindEveryMs
            return Remind(watchedMs)
        }
        return null
    }

    private fun tickLocked(nowMs: Long, watchedAppInForeground: Boolean): Event? {
        if (nowMs >= lockoutUntilMs) {
            reset()
            return null
        }
        if (!watchedAppInForeground) return null
        // Bounce them straight back out, but leave the deadline alone.
        // Throttled so a redirect that doesn't take hold can't stack up an
        // overlay every single tick.
        if (nowMs - lastSwitchAtMs < SWITCH_THROTTLE_MS) return null
        lastSwitchAtMs = nowMs
        return SwitchAway(watchedMs, firstTime = false)
    }

    /**
     * Start the break now, before the budget runs out — for when the user is
     * done early and wants the lockout to start counting rather than leaving
     * unspent minutes tempting them. Treats the budget as spent, so the full
     * allowance comes back once the lockout ends.
     */
    fun lockNow(nowMs: Long): SwitchAway {
        watchedMs = limitMs
        val event = lock(nowMs, firstTime = true)
        // Bounce on the very next tick if they're still in the app, rather than
        // waiting out the throttle.
        lastSwitchAtMs = 0
        return event
    }

    private fun lock(nowMs: Long, firstTime: Boolean): SwitchAway {
        locked = true
        lockoutUntilMs = nowMs + lockoutMs
        lastSwitchAtMs = nowMs
        return SwitchAway(watchedMs, firstTime)
    }

    /**
     * Pick up state saved before the process was restarted, so being killed by
     * the system never hands back spent budget. The lockout deadline is an
     * absolute instant, so time served while the service was dead still counts.
     */
    fun restore(nowMs: Long, savedWatchedMs: Long, savedLocked: Boolean, savedLockoutUntilMs: Long) {
        watchedMs = savedWatchedMs.coerceIn(0L, MAX_RESTORED_WATCHED_MS)
        locked = savedLocked
        // A clock change could leave a deadline further out than a whole
        // lockout; never honour more than the configured wait.
        lockoutUntilMs = if (locked) savedLockoutUntilMs.coerceAtMost(nowMs + lockoutMs) else 0
        // The first tick after a restore credits nothing, so the gap the service
        // was down for is not charged as watching.
        lastTickAtMs = 0L
        lastSwitchAtMs = 0L
        // Skip past reminders already given for the time already spent.
        nextRemindAtMs = (watchedMs / remindEveryMs + 1) * remindEveryMs

        if (locked && nowMs >= lockoutUntilMs) reset()
    }

    /** Enforcement is paused (outside the active window): forget all progress. */
    fun onIdle(nowMs: Long) {
        lastTickAtMs = nowMs
        reset()
    }

    private fun reset() {
        watchedMs = 0
        nextRemindAtMs = remindEveryMs
        locked = false
        lockoutUntilMs = 0
        lastSwitchAtMs = 0
    }

    companion object {
        const val MAX_CREDIT_PER_TICK_MS = 15_000L
        const val SWITCH_THROTTLE_MS = 8_000L

        /** Guards against a corrupted stored value restoring an absurd total. */
        const val MAX_RESTORED_WATCHED_MS = 24L * 60 * 60 * 1000
    }
}
