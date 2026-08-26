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

    /** Null means "go to the home screen" instead of a specific app. */
    var redirectPackage: String?
        get() = sp.getString(KEY_REDIRECT_PKG, null)
        set(value) = sp.edit().putString(KEY_REDIRECT_PKG, value).apply()

    var redirectLabel: String?
        get() = sp.getString(KEY_REDIRECT_LABEL, null)
        set(value) = sp.edit().putString(KEY_REDIRECT_LABEL, value).apply()

    companion object {
        const val DEFAULT_WATCHED_PKG = "com.google.android.youtube"
        const val DEFAULT_WATCHED_LABEL = "YouTube"
        const val MIN_MINUTES = 1
        const val MAX_MINUTES = 720

        private const val KEY_WATCHED_PKG = "watched_pkg"
        private const val KEY_WATCHED_LABEL = "watched_label"
        private const val KEY_REMIND_MIN = "remind_min"
        private const val KEY_LIMIT_MIN = "limit_min"
        private const val KEY_REDIRECT_PKG = "redirect_pkg"
        private const val KEY_REDIRECT_LABEL = "redirect_label"
    }
}
