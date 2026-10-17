package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LimitCodecTest {

    private val youtube = AppLimit.of(
        packageName = "com.google.android.youtube",
        label = "YouTube",
        remindEveryMinutes = 10,
        limitMinutes = 20,
        lockoutMinutes = 45,
        activeStartMinutes = 8 * 60,
        activeEndMinutes = 20 * 60,
        cancelWaitMinutes = 5,
    )

    private val instagram = AppLimit.of(
        packageName = "com.instagram.android",
        label = "Instagram",
        remindEveryMinutes = 3,
        limitMinutes = 10,
        lockoutMinutes = 120,
        activeStartMinutes = 9 * 60,
        activeEndMinutes = 9 * 60,
        redirectPackage = "com.amazon.kindle",
        redirectLabel = "Kindle",
        cancelWaitMinutes = 30,
    )

    @Test
    fun severalAppsSurviveARoundTripIntact() {
        val decoded = LimitCodec.decode(LimitCodec.encode(listOf(youtube, instagram)))
        assertEquals(listOf(youtube, instagram), decoded)
    }

    @Test
    fun orderIsPreservedSoTheListDoesNotShuffleItself() {
        val decoded = LimitCodec.decode(LimitCodec.encode(listOf(instagram, youtube)))
        assertEquals(listOf("com.instagram.android", "com.google.android.youtube"),
            decoded.map { it.packageName })
    }

    @Test
    fun nothingStoredMeansNoRules() {
        assertTrue(LimitCodec.decode(null).isEmpty())
        assertTrue(LimitCodec.decode("").isEmpty())
        assertTrue(LimitCodec.decode("\n\n  \n").isEmpty())
    }

    @Test
    fun aLabelHoldingTheSeparatorsStillRoundTrips() {
        // App labels come from the package manager and can contain anything.
        val awkward = AppLimit.of(
            packageName = "com.example.app",
            label = "Tab\there\nand a back\\slash",
        )
        val decoded = LimitCodec.decode(LimitCodec.encode(listOf(awkward, youtube)))
        assertEquals(2, decoded.size)
        assertEquals("Tab\there\nand a back\\slash", decoded[0].label)
        assertEquals(youtube, decoded[1])
    }

    @Test
    fun homeScreenRedirectRoundTripsAsNoRedirect() {
        val decoded = LimitCodec.decode(LimitCodec.encode(listOf(youtube)))
        assertNull(decoded.single().redirectPackage)
        assertNull(decoded.single().redirectLabel)
    }

    @Test
    fun recordsWrittenByAnOlderVersionGainTheNewDefaults() {
        // Seven fields: no redirect and no cancel wait existed yet.
        val legacy = "com.instagram.android\tInstagram\t3\t10\t120\t540\t540"
        val decoded = LimitCodec.decode(legacy).single()
        assertEquals("Instagram", decoded.label)
        assertEquals(10, decoded.limitMinutes)
        assertEquals(AppLimit.DEFAULT_CANCEL_WAIT_MINUTES, decoded.cancelWaitMinutes)
        assertNull(decoded.redirectPackage)
    }

    @Test
    fun extraFieldsFromANewerVersionAreIgnoredRatherThanFatal() {
        val withExtras = LimitCodec.encode(listOf(youtube)) + "\tsomething\tnew"
        assertEquals(youtube, LimitCodec.decode(withExtras).single())
    }

    @Test
    fun unreadableNumbersFallBackToDefaults() {
        val corrupt = "com.example.app\tExample\tnot-a-number\t\t999999\t540\t600\t\t\t"
        val decoded = LimitCodec.decode(corrupt).single()
        assertEquals(AppLimit.DEFAULT_REMIND_MINUTES, decoded.remindEveryMinutes)
        assertEquals(AppLimit.DEFAULT_LIMIT_MINUTES, decoded.limitMinutes)
        // Clamped by AppLimit.of rather than honoured as written.
        assertEquals(AppLimit.MAX_MINUTES, decoded.lockoutMinutes)
        assertEquals(AppLimit.DEFAULT_CANCEL_WAIT_MINUTES, decoded.cancelWaitMinutes)
    }

    @Test
    fun aRecordWithNoPackageIsDropped() {
        val stored = "\tGhost\t5\t5\t5\t0\t0\t\t\t0\n" + LimitCodec.encode(listOf(youtube))
        assertEquals(listOf(youtube), LimitCodec.decode(stored))
    }

    @Test
    fun aSecondRuleForTheSameAppIsDropped() {
        // Two sets of rules for one app would race in the service, so the first
        // one wins and the duplicate is discarded.
        val stored = LimitCodec.encode(listOf(youtube)) + "\n" +
            LimitCodec.encode(listOf(youtube.copy(limitMinutes = 1)))
        val decoded = LimitCodec.decode(stored)
        assertEquals(1, decoded.size)
        assertEquals(20, decoded.single().limitMinutes)
    }

    @Test
    fun encodingIsStableSoSavingTwiceChangesNothing() {
        val once = LimitCodec.encode(listOf(youtube, instagram))
        assertEquals(once, LimitCodec.encode(LimitCodec.decode(once)))
    }
}
