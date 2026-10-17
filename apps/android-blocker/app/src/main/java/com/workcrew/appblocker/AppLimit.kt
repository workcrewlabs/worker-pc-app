package com.workcrew.appblocker

/**
 * Everything the blocker enforces for one app. Each limited app carries its own
 * full set of rules — YouTube can get 20 minutes between 08:00 and 20:00 with a
 * 45 minute lockout while Instagram gets 10 minutes all day with a 2 hour one —
 * so nothing here is shared with any other app.
 *
 * Build instances through [of], never the constructor: it is the only place the
 * bounds are applied, so a hand-edited or corrupted stored value can never
 * produce a zero-length timer or an absurd one.
 *
 * Kept free of Android imports so it is unit-testable on the JVM.
 */
data class AppLimit(
    val packageName: String,
    val label: String,
    /** How often the on-screen reminder interrupts, in minutes of use. */
    val remindEveryMinutes: Int,
    /** Total use allowed in one window before being switched away. */
    val limitMinutes: Int,
    /**
     * How long the app stays locked once the limit is hit. The allowance comes
     * back when this ends, so it doubles as the reset interval.
     */
    val lockoutMinutes: Int,
    /** Start of this app's daily enforcement window, in minutes from midnight. */
    val activeStartMinutes: Int,
    /** End of the window; equal to the start means all day. */
    val activeEndMinutes: Int,
    /** Null means "go to the home screen" instead of a specific app. */
    val redirectPackage: String?,
    val redirectLabel: String?,
    /**
     * How long this app's limit keeps being enforced after Stop is pressed.
     * Per-app so a stricter app can hold the whole blocker open for longer
     * than a lenient one; the blocker only stops once the longest wait is up.
     */
    val cancelWaitMinutes: Int,
) {
    val remindEveryMs: Long get() = remindEveryMinutes * 60_000L
    val limitMs: Long get() = limitMinutes * 60_000L
    val lockoutMs: Long get() = lockoutMinutes * 60_000L

    /** True when this app's window covers the whole day. */
    val allDay: Boolean get() = activeStartMinutes == activeEndMinutes

    fun newSession(): WatchSession = WatchSession(
        remindEveryMs = remindEveryMs,
        limitMs = limitMs,
        lockoutMs = lockoutMs,
    )

    companion object {
        const val MIN_MINUTES = 1
        const val MAX_MINUTES = 720
        const val DEFAULT_REMIND_MINUTES = 10
        const val DEFAULT_LIMIT_MINUTES = 20
        const val DEFAULT_LOCKOUT_MINUTES = 45
        const val DEFAULT_CANCEL_WAIT_MINUTES = 5
        const val DEFAULT_ACTIVE_START_MINUTES = 8 * 60
        const val DEFAULT_ACTIVE_END_MINUTES = 20 * 60

        /** The app most people are here to limit, offered as the first rule. */
        const val DEFAULT_PACKAGE = "com.google.android.youtube"
        const val DEFAULT_LABEL = "YouTube"

        /**
         * The only supported way to build an [AppLimit]: every minute value is
         * clamped into range and a blank redirect package is normalised to
         * "home screen". Defaults fill in anything the caller leaves out.
         */
        fun of(
            packageName: String,
            label: String = packageName,
            remindEveryMinutes: Int = DEFAULT_REMIND_MINUTES,
            limitMinutes: Int = DEFAULT_LIMIT_MINUTES,
            lockoutMinutes: Int = DEFAULT_LOCKOUT_MINUTES,
            activeStartMinutes: Int = DEFAULT_ACTIVE_START_MINUTES,
            activeEndMinutes: Int = DEFAULT_ACTIVE_END_MINUTES,
            redirectPackage: String? = null,
            redirectLabel: String? = null,
            cancelWaitMinutes: Int = DEFAULT_CANCEL_WAIT_MINUTES,
        ): AppLimit {
            val redirect = redirectPackage?.takeIf { it.isNotBlank() }
            return AppLimit(
                packageName = packageName,
                label = label.takeIf { it.isNotBlank() } ?: packageName,
                remindEveryMinutes = remindEveryMinutes.coerceIn(MIN_MINUTES, MAX_MINUTES),
                limitMinutes = limitMinutes.coerceIn(MIN_MINUTES, MAX_MINUTES),
                lockoutMinutes = lockoutMinutes.coerceIn(MIN_MINUTES, MAX_MINUTES),
                activeStartMinutes = clampMinuteOfDay(activeStartMinutes),
                activeEndMinutes = clampMinuteOfDay(activeEndMinutes),
                redirectPackage = redirect,
                // A label without a package would render as a redirect that
                // doesn't exist, so the two are kept in step.
                redirectLabel = redirect?.let { pkg ->
                    redirectLabel?.takeIf { it.isNotBlank() } ?: pkg
                },
                // Zero is allowed here: stopping right away is a valid choice.
                cancelWaitMinutes = cancelWaitMinutes.coerceIn(0, MAX_MINUTES),
            )
        }

        private fun clampMinuteOfDay(minutes: Int): Int =
            minutes.coerceIn(0, Schedule.MINUTES_PER_DAY - 1)
    }
}
