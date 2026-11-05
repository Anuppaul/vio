# VIO — Android screen-off and background audio

## Expected behavior

VIO uses a **user-started native Android mediaPlayback foreground service**
for continuous practice playback. Once the user presses Play:

- **Tanpura** continues using the compact, bundled SA PA / SA MA MP3 while the display is off or a different app is foregrounded.
- **Metronome** continues its beat generation on a native AudioTrack worker, not a JavaScript setTimeout or requestAnimationFrame.
- **Ear Tuner** can keep its reference sample or synthesized beep looping with the display locked.
- Changing pages within VIO does not stop the active background audio session.
- The Android notification provides **Pause / Play / Stop**, and returning to a module reads the current native service status.
- Only **one continuous mode** plays at a time; starting another replaces the previous mode.
- Sound Tuner and Scale Practice **microphone capture stops** when the Activity is paused (for privacy and CPU); Exercise sounds are short interaction effects, not continuous background practice sessions.
- Playback is explicitly user-initiated; the service is **not** automatically restarted after reboot or a force-stop.

This service intentionally keeps **the screen off**, avoiding the removed
`FLAG_KEEP_SCREEN_ON` thermal regression. No React animation, WebAudio
context, or WebView timers are needed for the background audio renderer.

## Android service structure

- `android/app/src/main/java/com/anuppaul/vio/BackgroundAudioService.java`:
  native MediaPlayer for bundled loops; AudioTrack PCM worker with low allocations for Metronome; platform MediaSession, audio-focus management, notification actions and scoped CPU wake locks.
- `BackgroundAudioPlugin.java`: Capacitor bridge, user-started foreground service and optional Android 13+ notification permission.
- `lib/background-audio.ts`: native-only bridge; browser/PWA keeps WebAudio.
- Android Manifest: `android:foregroundServiceType="mediaPlayback"`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
  `WAKE_LOCK`, and `POST_NOTIFICATIONS`.
- `scripts/sync-android.mjs`: preserves new plugin registration and required manifest entries after `npx cap sync android`.

**No arbitrary background execution permission is used.** User-initiated
playback has an ongoing foreground-service notification, and scoped partial
wake locks only protect audio generation. Denying notification permission
should not prevent audio, but notification controls may not be visible until
permission is granted in Android app settings.

## Build and source verification

On a machine with the Android SDK, Node.js 22, Java 21, NDK/CMake and FFmpeg:

```bash
git fetch origin
git switch feature/android-screen-off-audio
git pull --ff-only origin feature/android-screen-off-audio
npm ci
npm run test:android:thermal
npm run test:android:background
npm run android:apk
```

The build packages offline audio into `android/app/src/main/assets/public/assets`.
The native service opens those bundled assets using Android AssetManager
and writes only small, trusted MP3 files to the application's private cache
for MediaPlayer compatibility. **It does not stream from the internet.**

GitHub Actions remain **manual-only** and have not been triggered for this
feature. A source-level test is not proof the service compiles, runs, or
keeps its notification alive on an actual phone.

## Physical device acceptance

Test the exact APK built from this branch, not an older debug APK:

1. Start Tanpura SA PA, verify correct sound, lock phone for **30 minutes**,
   then unlock. Confirm continuous sound and no duplicate playback.
2. Repeat SA MA with 4–5 different keys. Listen through loop boundaries for
   audible gaps/clicks (Android MediaPlayer looping quality may vary by device).
3. Start Metronome at 60, 120, and 240 BPM, then change subdivision and
   click/tabla/drum. Lock phone for at least 20 minutes. Measure audio timing
   from a recording: visual animations are not a timing reference.
4. Start looping Ear Tuner notes; verify screen-off playback and switching
   between Natural and Beep.
5. Open another app and return. Test notification Pause, Play and Stop.
   Test with Bluetooth/headphones and a wired headset where available.
6. Confirm expected interruption behavior: incoming calls, navigation audio,
   losing audio focus, and output device changes.
7. Compare process CPU, battery temperature and remaining battery against
   the previous app at matched brightness/ambient temperature. A native
   partial wake lock is held only when streaming PCM is active.
8. Stop playback, leave the app, and verify the notification disappears,
   CPU returns to idle and no wake lock remains.

Do not equate passing build/static tests with actual screen-off acceptance.
Battery restrictions on some OEM phones can still interfere with playback;
test on the target devices before releasing.

## Remaining risks

- Gapless Tanpura loop boundaries are determined by the compact MP3
  asset and Android's codec behavior; they may differ from the in-app WebAudio
  buffer loop. Test audibly.
- This version uses the existing Android platform MediaSession and foreground
  notification rather than Media3. Further platform-specific media-control
  compatibility testing may be needed.
- Screen-off microphone detection is intentionally **not** supported.
