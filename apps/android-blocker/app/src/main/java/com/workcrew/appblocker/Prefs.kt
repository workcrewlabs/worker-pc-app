package com.workcrew.appblocker

import android.content.Context

/**
 * All settings live in local SharedPreferences — nothing ever leaves the phone.
 *
 * The per-app rules are stored as one encoded string (see [LimitCodec]) and the
 * bounds live in [AppLimit.of], so a corrupted or hand-edited value can never
 * produce a zero or absurd timer. Live session progress is stored per package
 * so one app's spent budget is never mistaken for another's.
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("app_blocker", Context.MODE_PRIVATE)

    /**
     * The limited apps and their rules. Reading migrates the single-app
     * settings written by earlier versions into one rule, so an update keeps
     * whatever the user had set rather than silently resetting it.
     */
    var limits: List<AppLimit>
        get() {
            val stored = sp.getString(KEY_LIMITS, null)
            if (stored != null) return LimitCodec.decode(stored)
            // First run on this version: write the migrated rule through so the
            // old keys are only ever read once.
            return listOf(legacyLimit()).also { store(it) }
        }
        set(value) = store(value)

    private fun store(value: List<AppLimit>) {
        // Re-encoding what decode() would accept keeps storage canonical:
        // clamped, de-duplicated by package, and free of blank records.
        val clean = LimitCodec.decode(LimitCodec.encode(value))
        sp.edit().putString(KEY_LIMITS, LimitCodec.encode(clean)).apply()
        // Progress for an app that is no longer limited would otherwise sit
        // around and be restored if the app were added back days later.
        clearSessionStateExcept(clean.map { it.packageName }.toSet())
    }

    fun limitFor(packageName: String): AppLimit? =
        limits.firstOrNull { it.packageName == packageName }

    /**
     * The rules as they were before per-app limits existed. The old keys had
     * their own defaults, which double as the defaults for a fresh install.
     */
    private fun legacyLimit(): AppLimit = AppLimit.of(
        packageName = sp.getString(KEY_WATCHED_PKG, AppLimit.DEFAULT_PACKAGE)
            ?: AppLimit.DEFAULT_PACKAGE,
        label = sp.getString(KEY_WATCHED_LABEL, AppLimit.DEFAULT_LABEL)
            ?: AppLimit.DEFAULT_LABEL,
        remindEveryMinutes = sp.getInt(KEY_REMIND_MIN, AppLimit.DEFAULT_REMIND_MINUTES),
        limitMinutes = sp.getInt(KEY_LIMIT_MIN, AppLimit.DEFAULT_LIMIT_MINUTES),
        lockoutMinutes = sp.getInt(KEY_LOCKOUT_MIN, AppLimit.DEFAULT_LOCKOUT_MINUTES),
        activeStartMinutes = sp.getInt(KEY_ACTIVE_START, AppLimit.DEFAULT_ACTIVE_START_MINUTES),
        activeEndMinutes = sp.getInt(KEY_ACTIVE_END, AppLimit.DEFAULT_ACTIVE_END_MINUTES),
        redirectPackage = sp.getString(KEY_REDIRECT_PKG, null),
        redirectLabel = sp.getString(KEY_REDIRECT_LABEL, null),
        cancelWaitMinutes = sp.getInt(KEY_STOP_DELAY_MIN, AppLimit.DEFAULT_CANCEL_WAIT_MINUTES),
    )

    /**
     * Wall-clock time at which a requested stop is allowed to take effect, or 0
     * when no stop is pending. Absolute so that editing the waits afterwards
     * can't shorten a wait already under way.
     */
    var stopAllowedAtMs: Long
        get() = sp.getLong(KEY_STOP_ALLOWED_AT, 0L)
        set(value) = sp.edit().putLong(KEY_STOP_ALLOWED_AT, value).apply()

    /**
     * How long after a stop blocking turns itself back on. Zero leaves a stop
     * as a stop. Editing it only affects the next stop — see [resumeAtMs].
     */
    var autoResumeMinutes: Int
        get() = sp.getInt(KEY_AUTO_RESUME_MIN, AutoResume.OFF)
            .coerceIn(AutoResume.OFF, AutoResume.MAX_WAIT_MINUTES)
        set(value) = sp.edit()
            .putInt(
                KEY_AUTO_RESUME_MIN,
                value.coerceIn(AutoResume.OFF, AutoResume.MAX_WAIT_MINUTES),
            ).apply()

    /**
     * Wall-clock instant blocking comes back by itself, or 0 when a stop is
     * final. Absolute and fixed when the stop takes effect, so shortening the
     * setting afterwards cannot call off a return already under way, and time
     * with the app killed or the phone off still counts towards it.
     */
    var resumeAtMs: Long
        get() = sp.getLong(KEY_RESUME_AT, 0L)
        set(value) = sp.edit().putLong(KEY_RESUME_AT, value).apply()

    /**
     * Whether the user wants the blocker on. Survives the process dying, so a
     * reboot, an OEM "app sleep" kill, or an app update can all be recovered
     * from — unlike the service's in-memory running flag. Cleared only when a
     * requested stop actually takes effect.
     */
    var blockerEnabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, false)
        set(value) = sp.edit().putBoolean(KEY_ENABLED, value).apply()

    /**
     * Live progress for one limited app, saved every time it changes so that
     * the service being killed and restarted — by the system, a reboot, or a
     * stop and start — cannot hand back budget the user already spent.
     */
    data class SavedState(
        val watchedMs: Long,
        val locked: Boolean,
        val lockoutUntilMs: Long,
        val savedAtMs: Long,
    )

    fun sessionState(packageName: String): SavedState? {
        val savedAt = sp.getLong(key(KEY_STATE_SAVED_AT, packageName), 0L)
        if (savedAt <= 0L) return null
        return SavedState(
            watchedMs = sp.getLong(key(KEY_STATE_WATCHED_MS, packageName), 0L),
            locked = sp.getBoolean(key(KEY_STATE_LOCKED, packageName), false),
            lockoutUntilMs = sp.getLong(key(KEY_STATE_LOCKOUT_UNTIL, packageName), 0L),
            savedAtMs = savedAt,
        )
    }

    fun saveSessionState(
        packageName: String,
        watchedMs: Long,
        locked: Boolean,
        lockoutUntilMs: Long,
        nowMs: Long,
    ) {
        sp.edit()
            .putLong(key(KEY_STATE_WATCHED_MS, packageName), watchedMs)
            .putBoolean(key(KEY_STATE_LOCKED, packageName), locked)
            .putLong(key(KEY_STATE_LOCKOUT_UNTIL, packageName), lockoutUntilMs)
            .putLong(key(KEY_STATE_SAVED_AT, packageName), nowMs)
            .apply()
    }

    fun clearSessionState(packageName: String) {
        sp.edit()
            .remove(key(KEY_STATE_WATCHED_MS, packageName))
            .remove(key(KEY_STATE_LOCKED, packageName))
            .remove(key(KEY_STATE_LOCKOUT_UNTIL, packageName))
            .remove(key(KEY_STATE_SAVED_AT, packageName))
            .apply()
    }

    /** Drops saved progress for every app outside [keep], including legacy keys. */
    fun clearSessionStateExcept(keep: Set<String>) {
        val editor = sp.edit()
        // Pre-multi-app builds stored one unprefixed set of state keys.
        LEGACY_STATE_KEYS.forEach { editor.remove(it) }
        sp.all.keys
            .filter { stored -> STATE_KEYS.any { stored.startsWith(it + KEY_PACKAGE_SEPARATOR) } }
            .filterNot { stored -> keep.any { stored.endsWith(KEY_PACKAGE_SEPARATOR + it) } }
            .forEach { editor.remove(it) }
        editor.apply()
    }

    private fun key(base: String, packageName: String): String =
        base + KEY_PACKAGE_SEPARATOR + packageName

    companion object {
        private const val KEY_LIMITS = "app_limits"
        private const val KEY_STOP_ALLOWED_AT = "stop_allowed_at"
        private const val KEY_AUTO_RESUME_MIN = "auto_resume_min"
        private const val KEY_RESUME_AT = "resume_at"
        private const val KEY_ENABLED = "blocker_enabled"

        // A character package names cannot contain, so splitting a stored key
        // back apart is unambiguous.
        private const val KEY_PACKAGE_SEPARATOR = "|"
        private const val KEY_STATE_WATCHED_MS = "state_watched_ms"
        private const val KEY_STATE_LOCKED = "state_locked"
        private const val KEY_STATE_LOCKOUT_UNTIL = "state_lockout_until"
        private const val KEY_STATE_SAVED_AT = "state_saved_at"

        // Written only by versions before per-app limits; read once to migrate.
        private const val KEY_STATE_PACKAGE = "state_package"

        private val STATE_KEYS = listOf(
            KEY_STATE_WATCHED_MS, KEY_STATE_LOCKED, KEY_STATE_LOCKOUT_UNTIL, KEY_STATE_SAVED_AT,
        )

        /** The same four keys as written before they were per-app, plus the app they named. */
        private val LEGACY_STATE_KEYS = STATE_KEYS + KEY_STATE_PACKAGE

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
    }
}
