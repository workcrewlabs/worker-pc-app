package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The guarantee these cover: two limited apps are completely separate. Running
 * one's allowance out locks that one and leaves the other alone, with its own
 * remaining time and its own lock.
 */
class BlockerEngineTest {

    private val minute = 60_000L
    private val tick = 5_000L
    private val noon = 12 * 60

    private val youtube = AppLimit.of(
        packageName = "com.google.android.youtube",
        label = "YouTube",
        remindEveryMinutes = 10,
        limitMinutes = 20,
        lockoutMinutes = 45,
        activeStartMinutes = 0,
        activeEndMinutes = 0, // all day
    )

    private val instagram = AppLimit.of(
        packageName = "com.instagram.android",
        label = "Instagram",
        remindEveryMinutes = 5,
        limitMinutes = 10,
        lockoutMinutes = 120,
        activeStartMinutes = 0,
        activeEndMinutes = 0, // all day
    )

    private fun engine(vararg limits: AppLimit) = BlockerEngine(limits.toList())

    /** Polls from [fromMs] to [toMs] with [foreground] on screen; returns the outcomes. */
    private fun run(
        engine: BlockerEngine,
        fromMs: Long,
        toMs: Long,
        foreground: String?,
        minutesOfDay: Int = noon,
    ): List<BlockerEngine.Outcome> {
        val out = mutableListOf<BlockerEngine.Outcome>()
        var t = fromMs
        while (t <= toMs) {
            out += engine.poll(t, minutesOfDay, foreground)
            t += tick
        }
        return out.filterNot { it is BlockerEngine.OffDuty }
    }

    private fun locked(engine: BlockerEngine, limit: AppLimit) =
        engine.sessionFor(limit.packageName)!!.locked

    private fun usedMs(engine: BlockerEngine, limit: AppLimit) =
        engine.sessionFor(limit.packageName)!!.watchedMs

    @Test
    fun runningOutOnYouTubeDoesNotLockInstagram() {
        val engine = engine(youtube, instagram)
        // Twenty minutes of YouTube: its own limit, reached in its own app.
        val events = run(engine, 0, 20 * minute + tick, youtube.packageName)

        assertTrue(locked(engine, youtube))
        assertFalse(locked(engine, instagram))
        // Instagram was never on screen, so it was never charged a second.
        assertEquals(0L, usedMs(engine, instagram))
        // And every event raised belonged to YouTube alone.
        assertTrue(events.all { it.limit == youtube })
    }

    @Test
    fun instagramStaysOpenableWithItsFullAllowanceWhileYouTubeIsLocked() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 20 * minute + tick, youtube.packageName)
        assertTrue(locked(engine, youtube))

        // Open Instagram while YouTube is locked: it is not bounced, and it
        // starts from its own untouched ten minutes.
        val at = 21 * minute
        val events = run(engine, at, at + 9 * minute, instagram.packageName)
        assertTrue(events.none { it is BlockerEngine.SwitchAway })
        assertFalse(locked(engine, instagram))
        assertTrue(usedMs(engine, instagram) >= 8 * minute)
        // YouTube's lock was neither extended nor lifted by any of that.
        assertTrue(locked(engine, youtube))
    }

    @Test
    fun bothCanBeLockedAtOnceAndEachKeepsItsOwnDeadline() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 20 * minute + tick, youtube.packageName)
        val youtubeUntil = engine.sessionFor(youtube.packageName)!!.lockoutUntilMs

        // Now run Instagram out too. Its lock is 120 minutes, not YouTube's 45.
        val at = 21 * minute
        run(engine, at, at + 10 * minute + tick, instagram.packageName)
        assertTrue(locked(engine, instagram))
        // Locking Instagram left YouTube's deadline exactly where it was.
        assertEquals(youtubeUntil, engine.sessionFor(youtube.packageName)!!.lockoutUntilMs)

        // YouTube's 45 minutes expire first; it reopens while Instagram waits on.
        val afterYouTube = youtubeUntil + tick
        run(engine, afterYouTube, afterYouTube + tick, foreground = null)
        assertFalse(locked(engine, youtube))
        assertEquals(0L, usedMs(engine, youtube))
        assertTrue(locked(engine, instagram))
    }

    @Test
    fun timeInOneAppIsNeverChargedToTheOther() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 9 * minute, youtube.packageName)
        run(engine, 10 * minute, 18 * minute, instagram.packageName)

        assertTrue(usedMs(engine, youtube) >= 8 * minute)
        assertTrue(usedMs(engine, youtube) < 10 * minute)
        assertTrue(usedMs(engine, instagram) >= 7 * minute)
        assertTrue(usedMs(engine, instagram) < 9 * minute)
    }

    @Test
    fun anAppOutsideItsOwnHoursDoesNotHoldUpTheOthers() {
        val morningOnly = instagram.copy(activeStartMinutes = 6 * 60, activeEndMinutes = 9 * 60)
        val engine = engine(youtube, morningOnly)
        // Noon: Instagram is off duty, YouTube is on duty all day.
        val outcomes = engine.poll(0, noon, youtube.packageName)
        assertTrue(outcomes.any { it is BlockerEngine.OffDuty && it.limit == morningOnly })

        run(engine, tick, 20 * minute + tick, youtube.packageName)
        assertTrue(locked(engine, youtube))
        assertFalse(locked(engine, morningOnly))
    }

    @Test
    fun onlyTheAppOnScreenAccruesTimeEvenWhenAnotherIsLimited() {
        val engine = engine(youtube, instagram)
        // A third, unlimited app is on screen the whole time.
        run(engine, 0, 30 * minute, "com.example.notlimited")
        assertEquals(0L, usedMs(engine, youtube))
        assertEquals(0L, usedMs(engine, instagram))
        assertFalse(locked(engine, youtube))
        assertFalse(locked(engine, instagram))
    }

    // --- Block now --------------------------------------------------------

    @Test
    fun blockNowStartsABreakForTheAppOnScreenOnly() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 5 * minute, youtube.packageName)

        val target = engine.lockNowTarget(noon, youtube.packageName)
        assertEquals(youtube, target)
        engine.lockNow(target!!, 5 * minute)

        assertTrue(locked(engine, youtube))
        // The whole point: Instagram is untouched.
        assertFalse(locked(engine, instagram))
        assertEquals(0L, usedMs(engine, instagram))
    }

    @Test
    fun blockNowFromTheHomeScreenPicksTheAppJustLeftRatherThanAllOfThem() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 5 * minute, youtube.packageName)
        // They put the phone down on the home screen.
        run(engine, 5 * minute + tick, 6 * minute, "com.android.launcher")

        val target = engine.lockNowTarget(noon, "com.android.launcher")
        assertEquals(youtube, target)
        engine.lockNow(target!!, 6 * minute)
        assertTrue(locked(engine, youtube))
        assertFalse(locked(engine, instagram))
    }

    @Test
    fun blockNowDoesNothingWhenThatAppIsAlreadyLocked() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 20 * minute + tick, youtube.packageName)
        assertTrue(locked(engine, youtube))
        // A stray tap must not reach past the locked app to lock the other.
        assertNull(engine.lockNowTarget(noon, youtube.packageName))
    }

    @Test
    fun blockNowDoesNothingBeforeAnyLimitedAppHasBeenOpened() {
        val engine = engine(youtube, instagram)
        run(engine, 0, minute, "com.android.launcher")
        assertNull(engine.lockNowTarget(noon, "com.android.launcher"))
    }

    @Test
    fun blockNowDoesNothingForAnAppOutsideItsHours() {
        val eveningOnly = youtube.copy(activeStartMinutes = 18 * 60, activeEndMinutes = 22 * 60)
        val engine = engine(eveningOnly)
        assertNull(engine.lockNowTarget(noon, eveningOnly.packageName))
    }

    // --- Redirects --------------------------------------------------------

    @Test
    fun beingPushedOutOfOneLockedAppNeverLandsYouInAnotherLockedApp() {
        val toInstagram = youtube.copy(
            redirectPackage = instagram.packageName, redirectLabel = "Instagram"
        )
        val toYouTube = instagram.copy(
            redirectPackage = youtube.packageName, redirectLabel = "YouTube"
        )
        val engine = engine(toInstagram, toYouTube)

        // While Instagram is still open, YouTube's redirect is honoured.
        run(engine, 0, 20 * minute + tick, toInstagram.packageName)
        assertTrue(locked(engine, toInstagram))
        assertEquals(
            instagram.packageName,
            engine.redirectFor(toInstagram, 21 * minute, noon),
        )

        // Once Instagram is locked too, each one falls back to the home screen
        // instead of bouncing the user between the two for the next two hours.
        val at = 21 * minute
        run(engine, at, at + 10 * minute + tick, toYouTube.packageName)
        assertTrue(locked(engine, toYouTube))
        val now = at + 11 * minute
        assertNull(engine.redirectFor(toInstagram, now, noon))
        assertNull(engine.redirectFor(toYouTube, now, noon))
    }

    @Test
    fun aRedirectToAnUnlimitedAppIsAlwaysHonoured() {
        val toKindle = youtube.copy(
            redirectPackage = "com.amazon.kindle", redirectLabel = "Kindle"
        )
        val engine = engine(toKindle, instagram)
        run(engine, 0, 20 * minute + tick, toKindle.packageName)
        assertEquals("com.amazon.kindle", engine.redirectFor(toKindle, 21 * minute, noon))
    }

    @Test
    fun aRedirectIntoAnAppThatIsOffDutyIsHonouredSinceItIsNotLocked() {
        val morningOnly = instagram.copy(activeStartMinutes = 6 * 60, activeEndMinutes = 9 * 60)
        val toInstagram = youtube.copy(
            redirectPackage = morningOnly.packageName, redirectLabel = "Instagram"
        )
        val engine = engine(toInstagram, morningOnly)
        run(engine, 0, 20 * minute + tick, toInstagram.packageName)
        assertEquals(
            morningOnly.packageName,
            engine.redirectFor(toInstagram, 21 * minute, noon),
        )
    }

    @Test
    fun noRedirectSetMeansTheHomeScreen() {
        val engine = engine(youtube)
        assertNull(engine.redirectFor(youtube, 0, noon))
    }

    // --- Notification ordering -------------------------------------------

    @Test
    fun theNotificationLeadsWithWhateverMattersMost() {
        val engine = engine(youtube, instagram)
        run(engine, 0, 20 * minute + tick, youtube.packageName)
        // Locked beats the app on screen.
        assertEquals(
            youtube,
            engine.byRelevance(noon, instagram.packageName).first(),
        )

        val fresh = engine(youtube, instagram)
        fresh.poll(0, noon, instagram.packageName)
        // Nothing locked, so the app on screen leads.
        assertEquals(instagram, fresh.byRelevance(noon, instagram.packageName).first())
    }
}
