package com.workcrew.appblocker

/**
 * Turns blocking back on by itself a set time after a stop, so stopping is a
 * pause rather than a decision you have to remember to undo.
 *
 * The return is stored as an absolute instant fixed when the stop takes
 * effect, for the same reason the cancel wait is: editing the setting
 * afterwards must not be able to push away a return already counting down.
 * Time spent with the app force-stopped, or the phone off, still counts.
 *
 * Kept free of Android imports so it is unit-testable on the JVM.
 */
object AutoResume {

    /** A wait of zero means a stop stays a stop, as it did before this existed. */
    const val OFF = 0

    /** What should be happening right now, given what is stored. */
    enum class State {
        /** Blocking is meant to be on; nothing to wait for. */
        RUNNING,

        /** The wait is over (or cannot be trusted): turn blocking back on. */
        RESUME_NOW,

        /** Still inside the wait; leave blocking off until the deadline. */
        WAITING,

        /** Stopped with no return scheduled. */
        OFF,
    }

    /**
     * The instant blocking should come back after a stop at [stoppedAtMs], or
     * 0 when the user has not asked for one.
     */
    fun deadlineFor(stoppedAtMs: Long, waitMinutes: Int): Long =
        if (waitMinutes <= OFF) 0L
        else stoppedAtMs + waitMinutes.coerceAtMost(MAX_WAIT_MINUTES) * 60_000L

    fun stateOf(blockerEnabled: Boolean, resumeAtMs: Long, nowMs: Long): State = when {
        blockerEnabled -> State.RUNNING
        resumeAtMs <= 0L -> State.OFF
        nowMs >= resumeAtMs -> State.RESUME_NOW
        // A clock moved backwards, or a hand-edited value, could otherwise park
        // the return days away. Anything beyond the longest wait the app allows
        // is not believable, and for a self-control tool the safe reading of an
        // untrustworthy deadline is "the wait is over".
        resumeAtMs - nowMs > MAX_WAIT_MINUTES * 60_000L -> State.RESUME_NOW
        else -> State.WAITING
    }

    /** How long is still to wait at [nowMs]; 0 once it is due or not scheduled. */
    fun remainingMs(resumeAtMs: Long, nowMs: Long): Long =
        if (resumeAtMs <= 0L) 0L else (resumeAtMs - nowMs).coerceAtLeast(0L)

    /** The same ceiling the per-app waits use, so one setting cannot outlast the rest. */
    const val MAX_WAIT_MINUTES = AppLimit.MAX_MINUTES
}
