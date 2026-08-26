# App Blocker (Android)

A tiny, fully local Android app that limits how long you spend in a chosen app
(YouTube by default):

- **Reminder** — after every 10 minutes of watching (configurable), a
  full-screen overlay interrupts whatever you were watching: *"You've been on
  YouTube for 10 minutes"*, with **Keep watching** and **Take a break** buttons.
- **Hard switch** — once you hit your total limit (default 20 minutes), it
  shows a "Time's up" screen and launches another app you picked (or the home
  screen). If you reopen YouTube before taking a real break (5+ minutes away),
  it switches you away again.

Everything runs on-device: no accounts, no network calls, no data collection.

## How it works

A foreground service polls Android's `UsageStatsManager` every 5 seconds to see
which app is on screen (screen-off time doesn't count). A small state machine
(`WatchSession`, unit-tested) accumulates watch time, fires a reminder every N
minutes, and fires the switch at the limit. The counter resets after you've
been away from the watched app for 5 minutes. Interruptions use a
"display over other apps" window; the switch launches the redirect app's
launcher intent.

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
5. Pick the app to limit (defaults to YouTube), your reminder interval, your
   total limit, and the app to be switched to.
6. Tap **Start blocking**.

**Recommended:** in system Settings → Apps → App Blocker → Battery, set
**Unrestricted**. Some phones (Samsung, Xiaomi, etc.) aggressively kill
background services, which would stop the timer.

## Limitations

- Polling is every 5 seconds, so timings are accurate to within a few seconds.
- This is a self-control tool, not a parental control: the phone's owner can
  always stop the service or revoke the permissions.
- Picture-in-picture playback may not always register as "on screen" since
  another app holds the foreground.
