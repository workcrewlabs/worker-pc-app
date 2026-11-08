package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLimitTest {

    @Test
    fun defaultsAreTheYouTubeShapedRule() {
        val limit = AppLimit.of(packageName = "com.google.android.youtube", label = "YouTube")
        assertEquals(10, limit.remindEveryMinutes)
        assertEquals(20, limit.limitMinutes)
        assertEquals(45, limit.lockoutMinutes)
        assertEquals(8 * 60, limit.activeStartMinutes)
        assertEquals(20 * 60, limit.activeEndMinutes)
        assertEquals(5, limit.cancelWaitMinutes)
        assertNull(limit.redirectPackage)
        assertFalse(limit.allDay)
    }

    @Test
    fun eachAppKeepsItsOwnNumbers() {
        val youtube = AppLimit.of(
            packageName = "com.google.android.youtube",
            label = "YouTube",
            limitMinutes = 20,
            lockoutMinutes = 45,
            activeStartMinutes = 8 * 60,
            activeEndMinutes = 20 * 60,
        )
        val instagram = AppLimit.of(
            packageName = "com.instagram.android",
            label = "Instagram",
            remindEveryMinutes = 3,
            limitMinutes = 10,
            lockoutMinutes = 120,
            activeStartMinutes = 9 * 60,
            activeEndMinutes = 9 * 60,
            cancelWaitMinutes = 30,
        )
        // Nothing is shared: the two rules disagree on every value.
        assertEquals(20, youtube.limitMinutes)
        assertEquals(10, instagram.limitMinutes)
        assertEquals(45, youtube.lockoutMinutes)
        assertEquals(120, instagram.lockoutMinutes)
        assertEquals(5, youtube.cancelWaitMinutes)
        assertEquals(30, instagram.cancelWaitMinutes)
        assertFalse(youtube.allDay)
        assertTrue(instagram.allDay)
    }

    @Test
    fun timersCannotBeZeroedOrBlownUp() {
        val tiny = AppLimit.of(
            packageName = "a",
            remindEveryMinutes = 0,
            limitMinutes = -5,
            lockoutMinutes = 0,
        )
        assertEquals(AppLimit.MIN_MINUTES, tiny.remindEveryMinutes)
        assertEquals(AppLimit.MIN_MINUTES, tiny.limitMinutes)
        assertEquals(AppLimit.MIN_MINUTES, tiny.lockoutMinutes)

        val huge = AppLimit.of(
            packageName = "a",
            remindEveryMinutes = 99_999,
            limitMinutes = 99_999,
            lockoutMinutes = 99_999,
            cancelWaitMinutes = 99_999,
        )
        assertEquals(AppLimit.MAX_MINUTES, huge.remindEveryMinutes)
        assertEquals(AppLimit.MAX_MINUTES, huge.limitMinutes)
        assertEquals(AppLimit.MAX_MINUTES, huge.lockoutMinutes)
        assertEquals(AppLimit.MAX_MINUTES, huge.cancelWaitMinutes)
    }

    @Test
    fun cancellingRightAwayIsAllowedButNegativeWaitsAreNot() {
        assertEquals(0, AppLimit.of(packageName = "a", cancelWaitMinutes = 0).cancelWaitMinutes)
        assertEquals(0, AppLimit.of(packageName = "a", cancelWaitMinutes = -9).cancelWaitMinutes)
    }

    @Test
    fun windowTimesStayInsideTheDay() {
        val limit = AppLimit.of(
            packageName = "a",
            activeStartMinutes = -1,
            activeEndMinutes = Schedule.MINUTES_PER_DAY + 500,
        )
        assertEquals(0, limit.activeStartMinutes)
        assertEquals(Schedule.MINUTES_PER_DAY - 1, limit.activeEndMinutes)
    }

    @Test
    fun blankRedirectMeansTheHomeScreen() {
        val limit = AppLimit.of(packageName = "a", redirectPackage = "  ", redirectLabel = "Books")
        assertNull(limit.redirectPackage)
        // A label with no package would render a redirect that doesn't exist.
        assertNull(limit.redirectLabel)
    }

    @Test
    fun aRedirectWithoutALabelFallsBackToItsPackage() {
        val limit = AppLimit.of(packageName = "a", redirectPackage = "com.example.books")
        assertEquals("com.example.books", limit.redirectLabel)
    }

    @Test
    fun aBlankLabelFallsBackToThePackageName() {
        assertEquals("com.example.app", AppLimit.of("com.example.app", label = " ").label)
    }

    @Test
    fun sessionsAreBuiltFromThisAppsOwnTimings() {
        val limit = AppLimit.of(
            packageName = "a",
            remindEveryMinutes = 2,
            limitMinutes = 4,
            lockoutMinutes = 6,
        )
        val session = limit.newSession()
        // Four minutes of use hits this rule's limit, not the default twenty.
        var t = 0L
        var locked = false
        while (t <= 5 * 60_000L) {
            if (session.onTick(t, true) is WatchSession.SwitchAway) locked = true
            t += 5_000L
        }
        assertTrue(locked)
        assertEquals(6 * 60_000L, limit.lockoutMs)
        assertEquals(2 * 60_000L, limit.remindEveryMs)
    }
}
