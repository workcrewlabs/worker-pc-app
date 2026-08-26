package com.workcrew.appblocker

/**
 * Pure time-accounting state machine for one watched app. The service feeds it a
 * tick every few seconds saying whether the watched app is on screen, and it
 * answers with the event (if any) the service should act on:
 *
 *  - [Remind] every `remindEveryMs` of accumulated watching (e.g. at 10, then 20
 *    minutes) so the service can interrupt the screen with a reminder.
 *  - [SwitchAway] once accumulated watching reaches `limitMs`, and again each
 *    time the user re-opens the watched app while still over the limit, so the
 *    service can push them into another app.
 *
 * The accumulated time resets after the user has stayed away from the watched
 * app for `resetAfterAwayMs` — a quick hop to check a message doesn't restart
 * the clock, but a real break does.
 *
 * Kept free of Android imports so it is unit-testable on the JVM.
 */
class WatchSession(
    private val remindEveryMs: Long,
    private val limitMs: Long,
    private val resetAfterAwayMs: Long,
) {
    sealed interface Event
    data class Remind(val watchedMs: Long) : Event
    data class SwitchAway(val watchedMs: Long) : Event

    var watchedMs: Long = 0
        private set

    private var lastTickAtMs = 0L
    private var awaySinceMs = -1L
    private var nextRemindAtMs = remindEveryMs
    private var limitFired = false

    fun onTick(nowMs: Long, watchedAppInForeground: Boolean): Event? {
        // Cap the credit per tick so a device that slept between ticks doesn't
        // get hours of watching charged in one jump.
        val elapsedMs =
            if (lastTickAtMs == 0L) 0L
            else (nowMs - lastTickAtMs).coerceIn(0L, MAX_CREDIT_PER_TICK_MS)
        lastTickAtMs = nowMs

        if (!watchedAppInForeground) {
            if (awaySinceMs < 0) awaySinceMs = nowMs
            if (watchedMs > 0 && nowMs - awaySinceMs >= resetAfterAwayMs) reset()
            // Leaving the app re-arms the switch, so coming back while still
            // over the limit gets pushed away again instead of being ignored.
            limitFired = false
            return null
        }

        awaySinceMs = -1
        watchedMs += elapsedMs

        if (watchedMs >= limitMs) {
            if (limitFired) return null
            limitFired = true
            return SwitchAway(watchedMs)
        }
        if (watchedMs >= nextRemindAtMs) {
            nextRemindAtMs += remindEveryMs
            return Remind(watchedMs)
        }
        return null
    }

    private fun reset() {
        watchedMs = 0
        nextRemindAtMs = remindEveryMs
        limitFired = false
    }

    companion object {
        const val MAX_CREDIT_PER_TICK_MS = 15_000L
    }
}
