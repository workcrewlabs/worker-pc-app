package com.workcrew.appblocker

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.os.Build

/**
 * Tracks which app is currently on screen by replaying UsageEvents. Stateful on
 * purpose: each [update] only reads events since the previous call, so the last
 * known foreground package survives quiet stretches where the system emits no
 * new events at all.
 */
class ForegroundAppTracker(private val usageStatsManager: UsageStatsManager) {

    var currentPackage: String? = null
        private set

    private var lastQueryEndMs = 0L

    // Same underlying value; ACTIVITY_RESUMED is just the non-deprecated name on API 29+.
    private val foregroundEventType =
        if (Build.VERSION.SDK_INT >= 29) UsageEvents.Event.ACTIVITY_RESUMED
        else @Suppress("DEPRECATION") UsageEvents.Event.MOVE_TO_FOREGROUND

    fun update(nowMs: Long) {
        val beginMs = if (lastQueryEndMs == 0L) nowMs - INITIAL_LOOKBACK_MS else lastQueryEndMs
        val events = usageStatsManager.queryEvents(beginMs, nowMs)
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == foregroundEventType) {
                currentPackage = event.packageName
            }
        }
        lastQueryEndMs = nowMs
    }

    companion object {
        private const val INITIAL_LOOKBACK_MS = 60L * 60 * 1000
    }
}
