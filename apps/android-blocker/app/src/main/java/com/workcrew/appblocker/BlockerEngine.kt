package com.workcrew.appblocker

/**
 * Runs one [WatchSession] per limited app and decides what the service should
 * do about them.
 *
 * **Every app is accounted for entirely on its own.** Each has its own window,
 * allowance, reminder cadence and lock, and only the app actually on screen is
 * charged for the time passing. Hitting the limit in one app locks that app and
 * nothing else: the others keep their own remaining time and stay openable. The
 * two places where one app could still reach another are closed here —
 * [redirectFor] refuses to throw someone from one locked app into another, and
 * [lockNowTarget] picks a single app rather than locking them all.
 *
 * Kept free of Android imports so the independence above is unit-testable on
 * the JVM; the service supplies the clock, the foreground app and persistence.
 */
class BlockerEngine(val limits: List<AppLimit>) {

    private val sessions: Map<String, WatchSession> =
        limits.associate { it.packageName to it.newSession() }

    /**
     * The limited app most recently seen on screen. "Block now" pressed from
     * the home screen means "I've just finished with that app", which is the
     * case the button exists for.
     */
    var lastLimitedPackage: String? = null
        private set

    /** What one app's session asked for on this poll. */
    sealed interface Outcome {
        val limit: AppLimit
    }

    /** Interrupt the screen with this app's reminder. */
    data class Remind(override val limit: AppLimit, val watchedMs: Long) : Outcome

    /**
     * Push the user out of this app. [firstTime] marks the moment its lock
     * began, as opposed to the repeat pushes that keep them out during it.
     */
    data class SwitchAway(override val limit: AppLimit, val firstTime: Boolean) : Outcome

    /** This app's window has closed; the service should drop its saved progress. */
    data class OffDuty(override val limit: AppLimit) : Outcome

    fun sessionFor(packageName: String): WatchSession? = sessions[packageName]

    fun limitFor(packageName: String): AppLimit? =
        limits.firstOrNull { it.packageName == packageName }

    fun isOnDuty(limit: AppLimit, minutesOfDay: Int): Boolean = Schedule.isWithinWindow(
        minutesOfDay, limit.activeStartMinutes, limit.activeEndMinutes
    )

    /**
     * Advance every app's session by one tick. [foregroundPackage] is the app
     * on screen, or null when the screen is off or it is an app with no limit.
     *
     * Only the foreground app can accrue time or ask to interrupt the screen,
     * so at most one [Remind] or [SwitchAway] comes back per poll — the rest
     * can only be [OffDuty].
     */
    fun poll(nowMs: Long, minutesOfDay: Int, foregroundPackage: String?): List<Outcome> {
        if (foregroundPackage != null && limitFor(foregroundPackage) != null) {
            lastLimitedPackage = foregroundPackage
        }
        val outcomes = mutableListOf<Outcome>()
        limits.forEach { limit ->
            val session = sessions[limit.packageName] ?: return@forEach
            if (!isOnDuty(limit, minutesOfDay)) {
                session.onIdle(nowMs)
                outcomes += OffDuty(limit)
                return@forEach
            }
            when (val event = session.onTick(nowMs, foregroundPackage == limit.packageName)) {
                is WatchSession.Remind -> outcomes += Remind(limit, event.watchedMs)
                is WatchSession.SwitchAway -> outcomes += SwitchAway(limit, event.firstTime)
                null -> Unit
            }
        }
        return outcomes
    }

    /**
     * Where to send someone being pushed out of [limit]: its own redirect
     * target, or null for the home screen.
     *
     * If that target is itself an app that is locked right now, the home
     * screen is used instead. Landing in a locked app only gets you bounced
     * out of that one too, and two apps pointing at each other would ping-pong
     * you between them for as long as both locks last.
     */
    fun redirectFor(limit: AppLimit, nowMs: Long, minutesOfDay: Int): String? {
        val target = limit.redirectPackage ?: return null
        val targetLimit = limitFor(target) ?: return target
        val targetSession = sessions[target] ?: return target
        val targetLocked = isOnDuty(targetLimit, minutesOfDay) &&
            targetSession.lockoutRemainingMs(nowMs) > 0
        return if (targetLocked) null else target
    }

    /**
     * The single app "Block now" should start a break for: the limited app on
     * screen, or failing that the one most recently on screen. Never more than
     * one — the apps are separate, so a tap meant for one must not spend the
     * budget of the others.
     *
     * Null when that app is off duty or already locked, so a stray tap can
     * neither restart a part-served wait nor lock something out of hours.
     */
    fun lockNowTarget(minutesOfDay: Int, foregroundPackage: String?): AppLimit? {
        val candidate = foregroundPackage?.let { limitFor(it) }
            ?: lastLimitedPackage?.let { limitFor(it) }
            ?: return null
        val session = sessions[candidate.packageName] ?: return null
        if (session.locked || !isOnDuty(candidate, minutesOfDay)) return null
        return candidate
    }

    /** Spends [limit]'s remaining budget and starts its lock, and only its lock. */
    fun lockNow(limit: AppLimit, nowMs: Long) {
        sessions[limit.packageName]?.lockNow(nowMs)
    }

    /**
     * The apps in the order the notification should mention them: whatever
     * matters most first. Something locked beats the app on screen, which
     * beats one that has started accruing time, which beats an idle or
     * off-duty one.
     */
    fun byRelevance(minutesOfDay: Int, foregroundPackage: String?): List<AppLimit> =
        limits.sortedWith(
            compareBy(
                { limit ->
                    val session = sessions[limit.packageName]
                    when {
                        session == null -> 5
                        session.locked -> 0
                        limit.packageName == foregroundPackage -> 1
                        !isOnDuty(limit, minutesOfDay) -> 4
                        session.watchedMs > 0 -> 2
                        else -> 3
                    }
                },
                { limit -> -(sessions[limit.packageName]?.watchedMs ?: 0L) },
            )
        )
}
