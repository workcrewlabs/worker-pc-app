package com.workcrew.appblocker

import android.content.Context

/**
 * All settings live in local SharedPreferences — nothing ever leaves the phone.
 * Minute values are clamped on both read and write so a corrupted or hand-edited
 * value can never produce a zero or absurd timer.
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("app_blocker", Context.MODE_PRIVATE)

    var watchedPackage: String
        get() = sp.getString(KEY_WATCHED_PKG, DEFAULT_WATCHED_PKG) ?: DEFAULT_WATCHED_PKG
        set(value) = sp.edit().putString(KEY_WATCHED_PKG, value).apply()

    var watchedLabel: String
        get() = sp.getString(KEY_WATCHED_LABEL, DEFAULT_WATCHED_LABEL) ?: DEFAULT_WATCHED_LABEL
        set(value) = sp.edit().putString(KEY_WATCHED_LABEL, value).apply()

    /** How often the on-screen reminder interrupts, in minutes of watching. */
    var remindEveryMinutes: Int
        get() = sp.getInt(KEY_REMIND_MIN, 10).coerceIn(MIN_MINUTES, MAX_MINUTES)
        set(value) = sp.edit().putInt(KEY_REMIND_MIN, value.coerceIn(MIN_MINUTES, MAX_MINUTES)).apply()

    /** Total watching allowed before being switched to the redirect app, in minutes. */
    var limitMinutes: Int
        get() = sp.getInt(KEY_LIMIT_MIN, 20).coerceIn(MIN_MINUTES, MAX_MINUTES)
        set(value) = sp.edit().putInt(KEY_LIMIT_MIN, value.coerceIn(MIN_MINUTES, MAX_MINUTES)).apply()

    /**
     * After the limit is hit, how long the user must stay continuously away
     * from the watched app before it opens again.
     */
    var lockoutMinutes: Int
        get() = sp.getInt(KEY_LOCKOUT_MIN, 45).coerceIn(MIN_MINUTES, MAX_MINUTES)
        set(value) = sp.edit().putInt(KEY_LOCKOUT_MIN, value.coerceIn(MIN_MINUTES, MAX_MINUTES)).apply()

    /** Null means "go to the home screen" instead of a specific app. */
    var redirectPackage: String?
        get() = sp.getString(KEY_REDIRECT_PKG, null)
        set(value) = sp.edit().putString(KEY_REDIRECT_PKG, value).apply()

    var redirectLabel: String?
        get() = sp.getString(KEY_REDIRECT_LABEL, null)
        set(value) = sp.edit().putString(KEY_REDIRECT_LABEL, value).apply()

    /** Start of the daily enforcement window, in minutes from midnight. */
    var activeStartMinutes: Int
        get() = sp.getInt(KEY_ACTIVE_START, DEFAULT_ACTIVE_START).coerceIn(0, Schedule.MINUTES_PER_DAY - 1)
        set(value) = sp.edit()
            .putInt(KEY_ACTIVE_START, value.coerceIn(0, Schedule.MINUTES_PER_DAY - 1)).apply()

    /** End of the daily enforcement window; equal to the start means all day. */
    var activeEndMinutes: Int
        get() = sp.getInt(KEY_ACTIVE_END, DEFAULT_ACTIVE_END).coerceIn(0, Schedule.MINUTES_PER_DAY - 1)
        set(value) = sp.edit()
            .putInt(KEY_ACTIVE_END, value.coerceIn(0, Schedule.MINUTES_PER_DAY - 1)).apply()

    /**
     * How long Stop takes to take effect. The blocker keeps enforcing during the
     * wait, so quitting in a moment of weakness costs as much as it should. Zero
     * stops immediately.
     */
    var stopDelayMinutes: Int
        get() = sp.getInt(KEY_STOP_DELAY_MIN, 5).coerceIn(0, MAX_MINUTES)
        set(value) = sp.edit().putInt(KEY_STOP_DELAY_MIN, value.coerceIn(0, MAX_MINUTES)).apply()

    /**
     * Wall-clock time at which a requested stop is allowed to take effect, or 0
     * when no stop is pending. Absolute so that editing the delay afterwards
     * can't shorten a wait already under way.
     */
    var stopAllowedAtMs: Long
        get() = sp.getLong(KEY_STOP_ALLOWED_AT, 0L)
        set(value) = sp.edit().putLong(KEY_STOP_ALLOWED_AT, value).apply()

    companion object {
        const val DEFAULT_WATCHED_PKG = "com.google.android.youtube"
        const val DEFAULT_WATCHED_LABEL = "YouTube"
        const val MIN_MINUTES = 1
        const val MAX_MINUTES = 720
        const val DEFAULT_ACTIVE_START = 8 * 60
        const val DEFAULT_ACTIVE_END = 20 * 60

        private const val KEY_WATCHED_PKG = "watched_pkg"
        private const val KEY_WATCHED_LABEL = "watched_label"
        private const val KEY_REMIND_MIN = "remind_min"
        private const val KEY_LIMIT_MIN = "limit_min"
        private const val KEY_LOCKOUT_MIN = "lockout_min"
        private const val KEY_REDIRECT_PKG = "redirect_pkg"
        private const val KEY_REDIRECT_LABEL = "redirect_label"
        private const val KEY_ACTIVE_START = "active_start_min"
        private const val KEY_ACTIVE_END = "active_end_min"
        private const val KEY_STOP_DELAY_MIN = "stop_delay_min"
        private const val KEY_STOP_ALLOWED_AT = "stop_allowed_at"
    }
}
