# App Blocker (Android)

A tiny, fully local Android app that limits how long you spend in a chosen app
(YouTube by default):

- **Active hours** — the limit only applies inside a daily window you set
  (default 08:00–20:00). Outside it the blocker stands down completely, and
  progress is cleared so each day's window starts fresh. Windows that cross
  midnight (e.g. 22:00–06:00) work; setting both times the same means all day.
- **Reminder** — after every 10 minutes of watching (configurable), a
  full-screen overlay interrupts whatever you were watching: *"You've been on
  YouTube for 10 minutes"*, with **Keep watching** and **Take a break** buttons.
- **Hard switch, then lockout** — once you hit your total limit (default 20
  minutes), it shows a "Time's up" screen and launches another app you picked
  (or the home screen). From then on the app stays locked: every attempt to
  open it bounces you straight back out, and the lock only lifts after you've
  been *continuously* away for the lockout period (default 45 minutes).
  Peeking at the app restarts that clock.
- **A wait before you can quit** — Stop doesn't take effect immediately. It
  starts a countdown (default 5 minutes) during which the blocker keeps
  enforcing; the service performs the stop itself, so closing the app doesn't
  shortcut it. Settings are locked while the blocker runs, so you can't weaken
  the limit without going through that wait first. Set the wait to 0 to stop
  right away.

Everything runs on-device: no accounts, no network calls, no data collection.

## How it works

A foreground service polls Android's `UsageStatsManager` every 5 seconds to see
which app is on screen (screen-off time doesn't count). A small state machine
(`WatchSession`, unit-tested) accumulates watch time, fires a reminder every N
minutes, fires the switch at the limit, and then holds the lockout until a full
uninterrupted break has passed. Before the limit, a shorter 5-minute break
clears the accumulated time so a quick hop to check a message doesn't burn the
budget. `Schedule` (also unit-tested) decides whether the current time falls in
the active window. Interruptions use a "display over other apps" window; the
switch launches the redirect app's launcher intent.

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
5. Set it up: the app to limit (defaults to YouTube), the active hours, your
   reminder interval, your total limit, the lockout length, the app to be
   switched to, and how long Stop should take to take effect.
6. Tap **Start blocking**. The settings grey out — to change them, Stop first
   and wait out the delay you chose.

**Recommended:** in system Settings → Apps → App Blocker → Battery, set
**Unrestricted**. Some phones (Samsung, Xiaomi, etc.) aggressively kill
background services, which would stop the timer.

## Limitations

- Polling is every 5 seconds, so timings are accurate to within a few seconds.
- This is a self-control tool, not a parental control. The stop delay and
  locked settings add real friction, but the phone's owner can still force-stop
  the app, revoke its permissions, or uninstall it from system settings.
- Picture-in-picture playback may not always register as "on screen" since
  another app holds the foreground.
