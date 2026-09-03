package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchSessionTest {

    private val minute = 60_000L
    private val tickMs = 5_000L

    private fun newSession() = WatchSession(
        remindEveryMs = 10 * minute,
        limitMs = 20 * minute,
        resetAfterAwayMs = 5 * minute,
        lockoutMs = 45 * minute,
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
    fun switchesAwayAtTheLimitAndLocks() {
        val session = newSession()
        val events = run(session, 0, 21 * minute, foreground = true)
        assertTrue(events[0].second is WatchSession.Remind)
        val switch = events.first { it.second is WatchSession.SwitchAway }.second
        assertTrue((switch as WatchSession.SwitchAway).firstTime)
        assertTrue(session.locked)
    }

    @Test
    fun keepsPushingTheUserOutWhileLocked() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        assertTrue(session.locked)

        // Away for a couple of minutes, well short of the 45-minute lockout.
        var t = 21 * minute
        run(session, t, t + 2 * minute, foreground = false)
        assertTrue(session.locked)

        // Re-opening the app is bounced again, and not as a "time's up" event.
        t += 2 * minute + tickMs
        val events = run(session, t, t + 30_000L, foreground = true)
        val repeat = events.map { it.second }.filterIsInstance<WatchSession.SwitchAway>()
        assertTrue(repeat.isNotEmpty())
        assertFalse(repeat.first().firstTime)
    }

    @Test
    fun repeatSwitchesAreThrottled() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        var t = 21 * minute
        run(session, t, t + 2 * minute, foreground = false)

        // One minute of staying in the app at a 5s poll would be 12 ticks; the
        // throttle keeps that from becoming 12 overlays.
        t += 2 * minute + tickMs
        val switches = run(session, t, t + minute, foreground = true)
            .map { it.second }
            .filterIsInstance<WatchSession.SwitchAway>()
        assertTrue(switches.size in 1..8)
    }

    @Test
    fun lockoutLiftsOnlyAfterTheFullBreak() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        val lockedAt = 21 * minute

        // 44 minutes away is not enough.
        run(session, lockedAt, lockedAt + 44 * minute, foreground = false)
        assertTrue(session.locked)

        // Crossing 45 minutes unlocks and clears the spent budget.
        run(session, lockedAt + 44 * minute + tickMs, lockedAt + 46 * minute, foreground = false)
        assertFalse(session.locked)
        assertEquals(0, session.watchedMs)
    }

    @Test
    fun returningDuringLockoutRestartsTheBreakClock() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        var t = 21 * minute

        // 40 minutes away, then a peek at the app, then 40 more minutes away.
        run(session, t, t + 40 * minute, foreground = false)
        t += 40 * minute + tickMs
        run(session, t, t + 30_000L, foreground = true)
        t += 30_000L + tickMs
        run(session, t, t + 40 * minute, foreground = false)
        // Still locked: neither stretch away reached the full 45 minutes.
        assertTrue(session.locked)

        // Only a full uninterrupted 45 minutes clears it.
        t += 40 * minute + tickMs
        run(session, t, t + 6 * minute, foreground = false)
        assertFalse(session.locked)
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

    @Test
    fun goingIdleOutsideTheWindowClearsEverything() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        assertTrue(session.locked)

        session.onIdle(25 * minute)
        assertFalse(session.locked)
        assertEquals(0, session.watchedMs)

        // A fresh window starts with the full budget again.
        val events = run(session, 26 * minute, 35 * minute, foreground = true)
        assertTrue(events.none { it.second is WatchSession.SwitchAway })
    }
}
