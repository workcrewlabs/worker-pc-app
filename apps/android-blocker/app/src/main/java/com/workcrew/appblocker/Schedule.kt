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

    fun format(minutes: Int): String {
        val safe = minutes.coerceIn(0, MINUTES_PER_DAY - 1)
        return String.format(Locale.US, "%02d:%02d", safe / 60, safe % 60)
    }

    const val MINUTES_PER_DAY = 24 * 60
}
