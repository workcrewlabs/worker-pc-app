package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchSessionTest {

    private val minute = 60_000L
    private val tickMs = 5_000L

    private fun newSession() = WatchSession(
        remindEveryMs = 10 * minute,
        limitMs = 20 * minute,
        resetAfterAwayMs = 5 * minute,
    )

    /** Ticks from [fromMs] to [toMs] and returns every non-null event with its timestamp. */
    private fun run(
        session: WatchSession,
        fromMs: Long,
        toMs: Long,
        foreground: Boolean,
    ): List<Pair<Long, WatchSession.Event>> {
        val events = mutableListOf<Pair<Long, WatchSession.Event>>()
        var t = fromMs
        while (t <= toMs) {
            session.onTick(t, foreground)?.let { events.add(t to it) }
            t += tickMs
        }
        return events
    }

    @Test
    fun remindsAfterTenMinutesOfWatching() {
        val session = newSession()
        val events = run(session, 0, 10 * minute + tickMs, foreground = true)
        assertEquals(1, events.size)
        val event = events.single().second
        assertTrue(event is WatchSession.Remind)
        assertTrue((event as WatchSession.Remind).watchedMs >= 10 * minute)
    }

    @Test
    fun noEventBeforeTheReminderThreshold() {
        val session = newSession()
        val events = run(session, 0, 9 * minute, foreground = true)
        assertTrue(events.isEmpty())
    }

    @Test
    fun switchesAwayAtTheLimitInsteadOfASecondReminder() {
        val session = newSession()
        val events = run(session, 0, 21 * minute, foreground = true)
        assertEquals(2, events.size)
        assertTrue(events[0].second is WatchSession.Remind)
        assertTrue(events[1].second is WatchSession.SwitchAway)
    }

    @Test
    fun switchesAgainWhenUserReturnsWhileStillOverTheLimit() {
        val session = newSession()
        var t = 0L
        // Watch straight through the limit.
        var events = run(session, t, 20 * minute + tickMs, foreground = true)
        assertTrue(events.last().second is WatchSession.SwitchAway)
        // Away for one minute (less than the reset window), then reopen the app.
        t = 20 * minute + 2 * tickMs
        run(session, t, t + 1 * minute, foreground = false)
        events = run(session, t + 1 * minute + tickMs, t + 1 * minute + 3 * tickMs, foreground = true)
        assertTrue(events.any { it.second is WatchSession.SwitchAway })
    }

    @Test
    fun counterResetsAfterALongBreak() {
        val session = newSession()
        run(session, 0, 9 * minute, foreground = true)
        // Away for six minutes — longer than the five-minute reset window.
        run(session, 9 * minute + tickMs, 15 * minute + tickMs, foreground = false)
        assertEquals(0, session.watchedMs)
        // Nine more minutes of watching stays under the reminder threshold again.
        val events = run(session, 16 * minute, 25 * minute - tickMs, foreground = true)
        assertTrue(events.isEmpty())
    }

    @Test
    fun shortHopAwayDoesNotResetTheCounter() {
        val session = newSession()
        run(session, 0, 9 * minute, foreground = true)
        val before = session.watchedMs
        // One minute away — under the reset window.
        run(session, 9 * minute + tickMs, 10 * minute + tickMs, foreground = false)
        assertEquals(before, session.watchedMs)
    }

    @Test
    fun deviceSleepGapIsNotChargedAsWatching() {
        val session = newSession()
        session.onTick(0, true)
        // Next tick arrives an hour later (device slept); credit is capped.
        session.onTick(60 * minute, true)
        assertTrue(session.watchedMs <= WatchSession.MAX_CREDIT_PER_TICK_MS)
    }
}
