# App Blocker (Android)

A tiny, fully local Android app that limits how long you spend in the apps you
choose. Add as many as you like — each one carries its own complete set of
rules, so YouTube can get 20 minutes between 08:00 and 20:00 with a 45 minute
lock while Instagram gets 10 minutes all day with a 2 hour one. Nothing is
shared between apps: time spent in one never counts against another, and one
being locked says nothing about the rest.

Per app, you set:

- **Active hours** — the limit only applies inside that app's own daily window
  (default 08:00–20:00). Outside it the limit stands down completely for that
  app, and its progress is cleared so each day's window starts fresh. Windows
  that cross midnight (e.g. 22:00–06:00) work; setting both times the same
  means all day.
- **Reminder** — after every 10 minutes in the app (configurable), a
  full-screen overlay interrupts whatever you were watching: *"You've been on
  YouTube for 10 minutes"*, with **Keep watching** and **Take a break** buttons.
- **One budget for the whole window** — the limit is a running total for that
  app, not a per-sitting allowance. Breaks never refund time: five minutes now
  and five minutes an hour later still add up to ten. The total is kept across
  a service restart, a reboot, or a stop and start, so nothing hands back time
  you already spent. It resets only when you serve that app's full lock or its
  window ends.
- **Hard switch, then lock** — once you hit an app's total limit (default 20
  minutes), it shows a "Time's up" screen and launches the app you picked for
  it (or the home screen). From then on *that* app stays locked: every attempt
  to open it bounces you straight back out, until its lock period (default 45
  minutes) has passed — which is also when its allowance comes back. The
  countdown runs to a fixed deadline, so opening the locked app by reflex gets
  you bounced but does *not* start the wait over — you are thrown out in under
  a second, and that shouldn't cost you 45 more.
- **A wait before that app's limit can be cancelled** — default 5 minutes. See
  *Stopping* below.

Across all of them:

- **Block now** — the ongoing notification carries a **Block now** button.
  Tap it when you've finished watching (or finished eating) early and want the
  break to start right away instead of leaving unspent minutes tempting you.
  It spends the rest of the budget and starts the lock there and then, so it
  can't be used to bank minutes for later. Pressed while you're in one of the
  limited apps it starts that app's break only; pressed from anywhere else it
  starts the break for every app currently on duty. Apps that are off duty or
  already locked are skipped, so a stray tap can't restart a wait that is
  already part-served.
- **Status at a glance** — the ongoing notification shows the app that matters
  most right now (something locked beats the app you're in, which beats one
  that has started accruing time). Expand it for a line per limited app.
- **Stopping** — Stop doesn't take effect immediately. It starts a countdown
  during which every limit keeps being enforced; the service performs the stop
  itself, so closing the app doesn't shortcut it. Because Stop stops every
  limit at once, the wait is the **longest** cancel wait among your apps —
  otherwise a lenient app's short wait would be a back door to cancelling a
  strict one early. The list of apps is locked while the blocker runs, so you
  can't weaken or delete a limit without going through that wait first. Set
  every app's wait to 0 to stop right away.

Everything runs on-device: no accounts, no network calls, no data collection.

## How it works

A foreground service polls Android's `UsageStatsManager` every 5 seconds to see
which app is on screen (screen-off time doesn't count). It runs one state
machine per limited app, built from that app's own timings: `WatchSession`
(unit-tested) accumulates time, fires a reminder every N minutes, fires the
switch at the limit, and then holds the lock until the break has been served.
Only the app actually on screen accrues time, so at most one of them can
interrupt the screen in a given poll.

Each app's rules live in an `AppLimit` (unit-tested), and the whole list is
stored in one SharedPreferences string by `LimitCodec` (unit-tested), which is
deliberately forgiving when reading it back: missing trailing fields take
defaults, extra ones are ignored, unreadable numbers fall back and are clamped,
and a record with no package name — or a second record for an app already seen,
which would race — is dropped. Settings written by the earlier single-app
version are migrated into one rule on first read, so an update keeps whatever
you had set.

Progress is written per app whenever it changes and restored on start — checked
against that app's current window — so a restart cannot reset the count, and one
app's spent budget is never mistaken for another's. A lock is stored as the
wall-clock instant it lifts, so time served while the service was dead still
counts and nothing in between can push it back. Progress for an app you stop
limiting is dropped with it. `Schedule` (also unit-tested) decides whether the
current time falls in a given window and when that window last began.
Interruptions use a "display over other apps" window; the switch launches that
app's redirect target's launcher intent.

## Build

Requires the Android SDK (via [Android Studio](https://developer.android.com/studio)
or command-line tools). Open `apps/android-blocker` in Android Studio and press
Run, or from the CLI:

```bash
cd apps/android-blocker
./gradlew :app:assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

If the `gradlew` wrapper is missing its jar on your machine, run
`gradle wrapper --gradle-version 8.14.3` once (or let Android Studio repair it).

## Phone setup (one time)

1. Open **App Blocker** on the phone.
2. Grant **Usage access** (button opens the system settings page — find App
   Blocker in the list and enable it). This is how it knows which app is on
   screen.
3. Grant **Display over other apps** (second button). This is what lets
   reminders interrupt the screen and lets the app switch you away.
4. Allow notifications when prompted (Android 13+), so the ongoing
   "X of Y min used" status notification shows.
5. Set it up. **Limited apps** starts with one rule for YouTube; tap **Edit**
   to change its hours, allowance, reminder interval, lock length, where to be
   switched, and how long cancelling it has to wait. Tap **Add an app** for
   each further app you want limited and fill in its own values —
   **Remove** drops one.
6. Tap **Start blocking**. The list greys out — to change it, Stop first and
   wait out the longest cancel wait you set.

**Important:** grant the **Unrestricted battery** row on the setup screen (or
Settings → Apps → App Blocker → Battery → Unrestricted). Phone makers put idle
apps to sleep overnight, and that is the main thing that can stop the blocker.

On Samsung (One UI), there is a second place to check, because its battery
manager can sleep an app even when Android says it is unrestricted:
Settings → Battery → **Background usage limits** → make sure App Blocker is not
listed under **Sleeping apps** or **Deep sleeping apps**, and turn off
**Put unused apps to sleep**.

## Staying on

Blocking is meant to survive everything short of uninstalling the app, because a
blocker that quietly switches off overnight is worse than none. The intent to
block is stored on disk, and it is re-asserted from four places:

- `START_STICKY`, for an ordinary low-memory kill.
- `BootReceiver`, for a reboot or an app update — without it, a restart leaves
  the phone unguarded until someone notices.
- A repeating watchdog alarm (~15 min, allowed to fire in Doze), which covers
  the case `START_STICKY` does not: an OEM battery manager force-sleeping the
  app while the phone is idle.
- Opening the setup screen, which restarts the service immediately if needed.

Only a stop the user waits out clears the stored intent; a restart never
cancels a stop that is already counting down.

## Limitations

- Polling is every 5 seconds, so timings are accurate to within a few seconds.
- This is a self-control tool, not a parental control. The cancel waits and
  locked list add real friction, but the phone's owner can still force-stop
  the app, revoke its permissions, or uninstall it from system settings.
- Picture-in-picture playback may not always register as "on screen" since
  another app holds the foreground.
