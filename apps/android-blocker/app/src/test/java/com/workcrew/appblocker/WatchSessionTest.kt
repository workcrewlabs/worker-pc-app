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
    fun aLongBreakDoesNotRefundSpentBudget() {
        val session = newSession()
        run(session, 0, 5 * minute, foreground = true)
        val afterFirstSitting = session.watchedMs
        assertTrue(afterFirstSitting >= 5 * minute - tickMs)

        // An hour away — under the old behaviour this wiped the counter.
        run(session, 5 * minute + tickMs, 65 * minute, foreground = false)
        assertEquals(afterFirstSitting, session.watchedMs)

        // A second five-minute sitting adds to the first rather than restarting it.
        run(session, 65 * minute + tickMs, 70 * minute, foreground = true)
        assertTrue(session.watchedMs >= 10 * minute - 2 * tickMs)
    }

    @Test
    fun theLimitIsReachedAcrossSeparateSittings() {
        val session = newSession()
        // 15 minutes, a long break, then 6 more: 21 total, so the limit lands in
        // the second sitting even though neither one alone would reach it.
        run(session, 0, 15 * minute, foreground = true)
        run(session, 15 * minute + tickMs, 90 * minute, foreground = false)
        val events = run(session, 90 * minute + tickMs, 96 * minute, foreground = true)

        val switch = events.map { it.second }.filterIsInstance<WatchSession.SwitchAway>()
        assertTrue(switch.isNotEmpty())
        assertTrue(switch.first().firstTime)
        assertTrue(session.locked)
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
        assertTrue(session.locked)
        val deadline = session.lockoutUntilMs

        // A minute short of the deadline is not enough.
        run(session, 21 * minute, deadline - minute, foreground = false)
        assertTrue(session.locked)

        // Crossing it unlocks and clears the spent budget.
        run(session, deadline - minute + tickMs, deadline + minute, foreground = false)
        assertFalse(session.locked)
        assertEquals(0, session.watchedMs)
    }

    @Test
    fun returningDuringLockoutDoesNotPushTheDeadlineBack() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        val deadline = session.lockoutUntilMs

        // Two peeks at the locked app. Each is bounced, but neither may move the
        // deadline — being thrown out within a second is not "watching again",
        // and charging a stray tap the whole wait over is what made the timer
        // appear to jump back to full.
        run(session, 25 * minute, 25 * minute + 30_000L, foreground = true)
        assertEquals(deadline, session.lockoutUntilMs)
        run(session, 40 * minute, 40 * minute + 30_000L, foreground = true)
        assertEquals(deadline, session.lockoutUntilMs)

        // So the break still ends exactly when it always would have.
        run(session, deadline - minute, deadline + tickMs, foreground = false)
        assertFalse(session.locked)
    }

    @Test
    fun lockoutRemainingCountsDownRatherThanResetting() {
        val session = newSession()
        run(session, 0, 20 * minute + tickMs, foreground = true)
        val lockedAt = session.lockoutUntilMs - 45 * minute

        assertEquals(45 * minute, session.lockoutRemainingMs(lockedAt))
        assertEquals(15 * minute, session.lockoutRemainingMs(lockedAt + 30 * minute))

        // A bounced entry 30 minutes in still leaves only 15 minutes owed.
        run(session, lockedAt + 30 * minute, lockedAt + 30 * minute + 10_000L, foreground = true)
        assertEquals(15 * minute, session.lockoutRemainingMs(lockedAt + 30 * minute))
    }

    @Test
    fun lockNowStartsTheBreakEarly() {
        val session = newSession()
        // Five minutes watched and they say they are done for now.
        run(session, 0, 5 * minute, foreground = true)
        val at = 5 * minute + tickMs

        val event = session.lockNow(at)
        assertTrue(event.firstTime)
        assertTrue(session.locked)
        assertEquals(45 * minute, session.lockoutRemainingMs(at))
        // The unspent budget goes with it, so this is a real break and not a way
        // to bank minutes for later.
        assertEquals(20 * minute, session.watchedMs)

        // It ends on the usual schedule, with the full allowance back.
        run(session, at + tickMs, at + 46 * minute, foreground = false)
        assertFalse(session.locked)
        assertEquals(0, session.watchedMs)
    }

    @Test
    fun lockNowBouncesOnTheNextTickWhenStillInTheApp() {
        val session = newSession()
        run(session, 0, 5 * minute, foreground = true)
        val at = 5 * minute + tickMs
        session.lockNow(at)

        // Pressing it from inside the app must not have to wait out the throttle.
        val bounces = run(session, at + tickMs, at + 2 * tickMs, foreground = true)
            .map { it.second }
            .filterIsInstance<WatchSession.SwitchAway>()
        assertTrue(bounces.isNotEmpty())
        assertFalse(bounces.first().firstTime)
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

    @Test
    fun restoreResumesSpentBudgetAfterARestart() {
        val session = newSession()
        val now = 100 * minute
        session.restore(now, savedWatchedMs = 18 * minute, savedLocked = false, savedLockoutUntilMs = 0)
        assertEquals(18 * minute, session.watchedMs)

        // Only two minutes of budget are left, so the limit lands almost at once
        // instead of the restart handing back a fresh twenty.
        val events = run(session, now, now + 3 * minute, foreground = true)
        assertTrue(events.any { it.second is WatchSession.SwitchAway })
    }

    @Test
    fun restoreDoesNotChargeTheTimeTheServiceWasDown() {
        val session = newSession()
        val now = 100 * minute
        session.restore(now, savedWatchedMs = 5 * minute, savedLocked = false, savedLockoutUntilMs = 0)
        // First tick after the restore credits nothing, even though the saved
        // state is from long before.
        session.onTick(now, true)
        assertEquals(5 * minute, session.watchedMs)
    }

    @Test
    fun restoreSkipsRemindersAlreadyGiven() {
        // A longer limit than the default, so the reminder under test isn't the
        // same moment as the switch-away.
        val session = WatchSession(
            remindEveryMs = 10 * minute,
            limitMs = 60 * minute,
            lockoutMs = 45 * minute,
        )
        val now = 100 * minute
        session.restore(now, savedWatchedMs = 12 * minute, savedLocked = false, savedLockoutUntilMs = 0)

        // The 10-minute reminder is already spent, so nothing fires again for it.
        val events = run(session, now, now + 7 * minute, foreground = true)
        assertTrue(events.none { it.second is WatchSession.Remind })

        // The next one is due at 20 minutes and still arrives.
        val later = run(session, now + 7 * minute + tickMs, now + 9 * minute, foreground = true)
        assertTrue(later.any { it.second is WatchSession.Remind })
    }

    @Test
    fun restoreKeepsALockoutThatIsStillOwed() {
        val session = newSession()
        val now = 100 * minute
        session.restore(
            now,
            savedWatchedMs = 20 * minute,
            savedLocked = true,
            savedLockoutUntilMs = now + 35 * minute,
        )
        assertTrue(session.locked)
        // Time served while the service was dead counts: 35 minutes left, not 45.
        assertEquals(35 * minute, session.lockoutRemainingMs(now))
    }

    @Test
    fun restoreClearsALockoutServedWhileTheServiceWasDead() {
        val session = newSession()
        val now = 100 * minute
        session.restore(
            now,
            savedWatchedMs = 20 * minute,
            savedLocked = true,
            savedLockoutUntilMs = now - 5 * minute,
        )
        assertFalse(session.locked)
        assertEquals(0, session.watchedMs)
    }

    @Test
    fun restoreCapsADeadlineBeyondAWholeLockout() {
        val session = newSession()
        val now = 100 * minute
        // A clock change could leave a deadline hours out; never honour more
        // than the configured wait.
        session.restore(
            now,
            savedWatchedMs = 20 * minute,
            savedLocked = true,
            savedLockoutUntilMs = now + 5 * 60 * minute,
        )
        assertTrue(session.locked)
        assertEquals(45 * minute, session.lockoutRemainingMs(now))
    }
}
