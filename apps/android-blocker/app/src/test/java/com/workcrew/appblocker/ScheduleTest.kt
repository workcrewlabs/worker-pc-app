package com.workcrew.appblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduleTest {

    private fun at(hour: Int, minute: Int = 0) = hour * 60 + minute

    @Test
    fun daytimeWindowCoversItsOwnHoursOnly() {
        val start = at(8)
        val end = at(20)
        assertTrue(Schedule.isWithinWindow(at(8), start, end))
        assertTrue(Schedule.isWithinWindow(at(13, 30), start, end))
        assertFalse(Schedule.isWithinWindow(at(7, 59), start, end))
        // The end is exclusive, so 20:00 is already off duty.
        assertFalse(Schedule.isWithinWindow(at(20), start, end))
        assertFalse(Schedule.isWithinWindow(at(23), start, end))
        assertFalse(Schedule.isWithinWindow(at(3), start, end))
    }

    @Test
    fun overnightWindowWrapsPastMidnight() {
        val start = at(22)
        val end = at(6)
        assertTrue(Schedule.isWithinWindow(at(22), start, end))
        assertTrue(Schedule.isWithinWindow(at(23, 59), start, end))
        assertTrue(Schedule.isWithinWindow(at(0), start, end))
        assertTrue(Schedule.isWithinWindow(at(5, 59), start, end))
        assertFalse(Schedule.isWithinWindow(at(6), start, end))
        assertFalse(Schedule.isWithinWindow(at(12), start, end))
    }

    @Test
    fun equalStartAndEndMeansAllDay() {
        assertTrue(Schedule.isWithinWindow(at(0), at(9), at(9)))
        assertTrue(Schedule.isWithinWindow(at(9), at(9), at(9)))
        assertTrue(Schedule.isWithinWindow(at(17, 45), at(9), at(9)))
    }

    @Test
    fun formatsAsZeroPaddedClockTime() {
        assertEquals("08:00", Schedule.format(at(8)))
        assertEquals("20:30", Schedule.format(at(20, 30)))
        assertEquals("00:05", Schedule.format(5))
    }
}
