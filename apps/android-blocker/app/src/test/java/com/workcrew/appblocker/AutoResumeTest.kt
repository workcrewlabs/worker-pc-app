package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoResumeTest {

    private val minute = 60_000L
    private val stoppedAt = 1_000_000_000_000L

    @Test
    fun aWaitOfZeroLeavesAStopAsAStop() {
        assertEquals(0L, AutoResume.deadlineFor(stoppedAt, AutoResume.OFF))
        assertEquals(
            AutoResume.State.OFF,
            AutoResume.stateOf(blockerEnabled = false, resumeAtMs = 0L, nowMs = stoppedAt),
        )
    }

    @Test
    fun theDeadlineIsTheStopPlusTheWait() {
        assertEquals(stoppedAt + 60 * minute, AutoResume.deadlineFor(stoppedAt, 60))
    }

    @Test
    fun anAbsurdWaitIsCappedAtTheSameCeilingTheOtherWaitsUse() {
        assertEquals(
            stoppedAt + AutoResume.MAX_WAIT_MINUTES * minute,
            AutoResume.deadlineFor(stoppedAt, 99_999),
        )
        assertEquals(AppLimit.MAX_MINUTES, AutoResume.MAX_WAIT_MINUTES)
    }

    @Test
    fun blockingStaysOffUntilTheDeadlineAndComesBackOnIt() {
        val resumeAt = AutoResume.deadlineFor(stoppedAt, 60)
        assertEquals(
            AutoResume.State.WAITING,
            AutoResume.stateOf(false, resumeAt, stoppedAt + 59 * minute),
        )
        assertEquals(
            AutoResume.State.RESUME_NOW,
            AutoResume.stateOf(false, resumeAt, resumeAt),
        )
        assertEquals(
            AutoResume.State.RESUME_NOW,
            AutoResume.stateOf(false, resumeAt, resumeAt + minute),
        )
    }

    @Test
    fun aPendingReturnIsIgnoredWhileBlockingIsAlreadyOn() {
        val resumeAt = AutoResume.deadlineFor(stoppedAt, 60)
        assertEquals(
            AutoResume.State.RUNNING,
            AutoResume.stateOf(blockerEnabled = true, resumeAtMs = resumeAt, nowMs = stoppedAt),
        )
    }

    @Test
    fun timeWithThePhoneOffStillCountsTowardsTheReturn() {
        // The deadline is an instant, not a stopwatch, so an hour of the phone
        // being off is an hour served — and the return is due the moment it
        // comes back on.
        val resumeAt = AutoResume.deadlineFor(stoppedAt, 60)
        assertEquals(
            AutoResume.State.RESUME_NOW,
            AutoResume.stateOf(false, resumeAt, stoppedAt + 3 * 60 * minute),
        )
    }

    @Test
    fun shorteningTheSettingDoesNotMoveAReturnAlreadyCountingDown() {
        // Changing the setting writes no new deadline, so the stored instant —
        // the only thing stateOf reads — still governs.
        val resumeAt = AutoResume.deadlineFor(stoppedAt, 120)
        assertEquals(
            AutoResume.State.WAITING,
            AutoResume.stateOf(false, resumeAt, stoppedAt + 90 * minute),
        )
        // And a fresh stop with the new setting gets the new wait.
        assertEquals(
            stoppedAt + 5 * minute,
            AutoResume.deadlineFor(stoppedAt, 5),
        )
    }

    @Test
    fun aDeadlineFurtherOutThanAnyAllowedWaitIsTreatedAsDue() {
        // A clock moved backwards, or a hand-edited value, must not be able to
        // park the return days away.
        val absurd = stoppedAt + 30L * 24 * 60 * minute
        assertEquals(
            AutoResume.State.RESUME_NOW,
            AutoResume.stateOf(false, absurd, stoppedAt),
        )
        // The longest believable wait is still honoured, though.
        val longest = AutoResume.deadlineFor(stoppedAt, AutoResume.MAX_WAIT_MINUTES)
        assertEquals(
            AutoResume.State.WAITING,
            AutoResume.stateOf(false, longest, stoppedAt + minute),
        )
    }

    @Test
    fun remainingTimeCountsDownAndNeverGoesNegative() {
        val resumeAt = AutoResume.deadlineFor(stoppedAt, 10)
        assertEquals(10 * minute, AutoResume.remainingMs(resumeAt, stoppedAt))
        assertEquals(4 * minute, AutoResume.remainingMs(resumeAt, stoppedAt + 6 * minute))
        assertEquals(0L, AutoResume.remainingMs(resumeAt, resumeAt))
        assertEquals(0L, AutoResume.remainingMs(resumeAt, resumeAt + 60 * minute))
        assertEquals(0L, AutoResume.remainingMs(0L, stoppedAt))
    }

    @Test
    fun aStopWithAReturnIsNeverIndistinguishableFromAFinalOne() {
        // The two stop outcomes the UI has to tell apart.
        val withReturn = AutoResume.deadlineFor(stoppedAt, 30)
        val finalStop = AutoResume.deadlineFor(stoppedAt, AutoResume.OFF)
        assertTrue(withReturn > 0L)
        assertEquals(0L, finalStop)
        assertEquals(AutoResume.State.WAITING, AutoResume.stateOf(false, withReturn, stoppedAt))
        assertEquals(AutoResume.State.OFF, AutoResume.stateOf(false, finalStop, stoppedAt))
    }
}
