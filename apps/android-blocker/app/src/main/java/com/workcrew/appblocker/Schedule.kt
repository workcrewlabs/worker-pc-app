package com.workcrew.appblocker

import java.util.Locale

/**
 * The daily window during which limits are enforced, expressed as minutes from
 * midnight (local time). Outside the window the blocker stands down entirely.
 *
 * Android-free so it is unit-testable on the JVM.
 */
object Schedule {

    /**
     * A window where start == end means "all day". A window whose end is before
     * its start crosses midnight (e.g. 22:00 to 06:00) and is treated as such.
     */
    fun isWithinWindow(nowMinutes: Int, startMinutes: Int, endMinutes: Int): Boolean = when {
        startMinutes == endMinutes -> true
        startMinutes < endMinutes -> nowMinutes >= startMinutes && nowMinutes < endMinutes
        else -> nowMinutes >= startMinutes || nowMinutes < endMinutes
    }

    /**
     * Wall-clock instant of the most recent occurrence of the window's start
     * time — today's if it has already passed, otherwise yesterday's. Saved
     * progress from before this instant belongs to an earlier window and is
     * stale, which is what gives the budget a daily rollover.
     */
    fun currentWindowStartMs(nowMs: Long, nowMinutes: Int, startMinutes: Int): Long {
        val minutesSinceStart = ((nowMinutes - startMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY) %
            MINUTES_PER_DAY
        return nowMs - minutesSinceStart * 60_000L
    }

    fun format(minutes: Int): String {
        val safe = minutes.coerceIn(0, MINUTES_PER_DAY - 1)
        return String.format(Locale.US, "%02d:%02d", safe / 60, safe % 60)
    }

    const val MINUTES_PER_DAY = 24 * 60
}
