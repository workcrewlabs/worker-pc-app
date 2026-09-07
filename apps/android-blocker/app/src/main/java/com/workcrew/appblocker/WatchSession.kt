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
 * only ways the budget comes back are serving the full lockout after hitting the
 * limit, or the active window ending (see [onIdle]).
 *
 * Reaching the limit starts that lockout: the watched app stays off-limits until
 * the user has been continuously away from it for `lockoutMs`. Re-opening it
 * restarts that clock, so the only way back in is a real break.
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
     * limit was hit (a "time's up" interruption) as opposed to the repeat
     * pushes that keep them out for the rest of the lockout.
     */
    data class SwitchAway(val watchedMs: Long, val firstTime: Boolean) : Event

    var watchedMs: Long = 0
        private set

    /** True while the watched app is off-limits and every entry is bounced. */
    var locked: Boolean = false
        private set

    /** Continuous time away still owed before the lockout lifts; 0 when unlocked. */
    var lockoutRemainingMs: Long = 0
        private set

    /**
     * Wall-clock time the current stretch away from the watched app began, or -1
     * while it is on screen. Exposed so the service can persist it and pick the
     * lockout back up where it left off after being restarted.
     */
    var awaySinceMs: Long = -1
        private set

    private var lastTickAtMs = 0L
    private var nextRemindAtMs = remindEveryMs
    private var lastSwitchAtMs = 0L

    fun onTick(nowMs: Long, watchedAppInForeground: Boolean): Event? {
        // Cap the credit per tick so a device that slept between ticks doesn't
        // get hours of watching charged in one jump.
        val elapsedMs =
            if (lastTickAtMs == 0L) 0L
            else (nowMs - lastTickAtMs).coerceIn(0L, MAX_CREDIT_PER_TICK_MS)
        lastTickAtMs = nowMs

        if (locked) return tickLocked(nowMs, watchedAppInForeground)

        if (!watchedAppInForeground) {
            // Note what time the break started (the lockout needs it later), but
            // hand back none of the budget: the limit spans the whole window.
            if (awaySinceMs < 0) awaySinceMs = nowMs
            return null
        }

        awaySinceMs = -1
        watchedMs += elapsedMs

        if (watchedMs >= limitMs) {
            locked = true
            lockoutRemainingMs = lockoutMs
            lastSwitchAtMs = nowMs
            return SwitchAway(watchedMs, firstTime = true)
        }
        if (watchedMs >= nextRemindAtMs) {
            nextRemindAtMs += remindEveryMs
            return Remind(watchedMs)
        }
        return null
    }

    private fun tickLocked(nowMs: Long, watchedAppInForeground: Boolean): Event? {
        if (watchedAppInForeground) {
            // Opening it again owes the full break from scratch.
            awaySinceMs = -1
            lockoutRemainingMs = lockoutMs
            // Throttled so a redirect that doesn't take hold doesn't stack up
            // an overlay every single tick.
            if (nowMs - lastSwitchAtMs < SWITCH_THROTTLE_MS) return null
            lastSwitchAtMs = nowMs
            return SwitchAway(watchedMs, firstTime = false)
        }

        if (awaySinceMs < 0) awaySinceMs = nowMs
        val awayMs = nowMs - awaySinceMs
        lockoutRemainingMs = (lockoutMs - awayMs).coerceAtLeast(0)
        if (awayMs >= lockoutMs) reset()
        return null
    }

    /**
     * Pick up state saved before the process was restarted, so being killed by
     * the system never hands back spent budget. [savedAwaySinceMs] is a
     * wall-clock instant, which means a lockout served while the service was
     * dead still counts.
     */
    fun restore(nowMs: Long, savedWatchedMs: Long, savedLocked: Boolean, savedAwaySinceMs: Long) {
        watchedMs = savedWatchedMs.coerceIn(0L, MAX_RESTORED_WATCHED_MS)
        locked = savedLocked
        awaySinceMs = savedAwaySinceMs.takeIf { it in 1..nowMs } ?: -1
        // The first tick after a restore credits nothing, so the gap the service
        // was down for is not charged as watching.
        lastTickAtMs = 0L
        lastSwitchAtMs = 0L
        // Skip past reminders already given for the time already spent.
        nextRemindAtMs = (watchedMs / remindEveryMs + 1) * remindEveryMs

        if (!locked) return
        lockoutRemainingMs = lockoutMs
        if (awaySinceMs < 0) return
        val awayMs = nowMs - awaySinceMs
        if (awayMs >= lockoutMs) reset() else lockoutRemainingMs = lockoutMs - awayMs
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
        lockoutRemainingMs = 0
        awaySinceMs = -1
        lastSwitchAtMs = 0
    }

    companion object {
        const val MAX_CREDIT_PER_TICK_MS = 15_000L
        const val SWITCH_THROTTLE_MS = 8_000L

        /** Guards against a corrupted stored value restoring an absurd total. */
        const val MAX_RESTORED_WATCHED_MS = 24L * 60 * 60 * 1000
    }
}
