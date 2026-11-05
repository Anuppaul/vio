# VIO APK — prolonged audio thermal audit

## Symptoms

VIO may warm an Android phone during long Tanpura, Ear Tuner, Metronome, Exercise or Sound Tuner sessions. This document records source-backed efficiency defects and fixes. **It does not claim measured temperature, battery or APK performance improvements.**

## Confirmed source defects and changes

| Before | After |
| --- | --- |
| `MainActivity` applied `FLAG_KEEP_SCREEN_ON` to **every** app page, including idle and prolonged playback. | Removed the global display wake flag. Normal Android screen timeout applies. |
| Tanpura synthesized fallback kept all finished oscillators in an ever-growing array. | Completed oscillators remove themselves and disconnect gain nodes; Stop also clears them. |
| Tanpura cached every decoded PCM sample visited (up to 24 samples, much larger than compressed MP3 files). | Android keeps at most 2 decoded note buffers and clears cache when playback ends. |
| Audio output context and graphs could remain active on Stop or page navigation. | Tanpura and Ear Tuner stop/disconnect audio nodes and close idle contexts; Metronome closes output and discards samples on Stop. |
| Native Tanpura animated two rings continuously during playback. | Rings stay still in the APK, preserving the sound. |
| Metronome instantiated a DynamicsCompressor **every** main click. | One master limiter; per-beat source+gain nodes disconnect after playback. |
| Metronome used an ongoing 60-fps visual rAF loop, including after Stop. | Cancels animation on Stop; Android visuals use a 60-ms timer while running. |
| Metronome scheduled every 25 ms even on Android. | Android audio lookahead is 230 ms, with a 60-ms scheduler; notes remain scheduled against AudioContext time. |
| Metronome created/resumed output merely by opening its page. | Audio initialization and sample decoding start on explicit Play/Start. |
| Exercise updated its entire UI every 250 ms even when there was no running challenge timer. | 1-second updates, only when a timed challenge or report requires them. |
| Native Pitch DSP relied on WebView JS for pause cleanup; JS may be throttled. | Native plugin stops capture in Android `handleOnPause()`, with UI-side visibility cleanup too. |

## Playback behavior

On Android, **Tanpura, Metronome and Ear Tuner now continue playing** through screen lock and page navigation using the dedicated native foreground mediaPlayback service. **Microphone capture still stops** on Activity pause for privacy and thermal efficiency. The native service uses a persistent playback notification with media controls and scoped wake locks. Its reliability and thermal impact still require long-duration on-device acceptance. See [ANDROID_SCREEN_OFF_AUDIO.md](ANDROID_SCREEN_OFF_AUDIO.md).

Hosted web/PWA audio behavior is not intentionally throttled; the new native-specific lifecycle handlers check `Capacitor.isNativePlatform()`. The decorative CSS change applies only to the `vio-native` app.

## Local verification without GitHub Actions

From the VIO repository:

```bash
git switch fix/android-audio-thermal
git pull --ff-only
npm ci
npm run test:android:thermal
npm run build:android:web
npm run test:android:web
npm run android:apk
```

These commands execute locally. `build:android:web` needs FFmpeg/FFprobe; Android packaging needs the Android SDK, NDK/CMake and a suitable JDK. The Android GitHub workflow is deliberately `workflow_dispatch` only; **do not manually dispatch it without owner approval**.

Do not confuse the earlier 1.0.0 APK artifacts with this branch; those do not contain the thermal patches.

## Physical thermal acceptance (not yet executed)

Using the *same* phone at the same ambient temperature and brightness, unplugged from charging, compare the previous APK against the patched APK, ideally after each cools to baseline. Stop if the device becomes uncomfortable to hold.

1. Record 5-minute idle app state: battery temperature, battery percentage, process CPU, screen brightness.
2. Play Tanpura SA PA continuously for 20 minutes with the display visible. Observe stable sound, no growing memory, no forced stay-awake.
3. Change Tanpura key repeatedly, then Stop/Start 10 times. Confirm no overlap, stutter or leaked nodes.
4. Run 20 minutes of Metronome at 120 BPM, then 240 BPM with subdivisions, testing Click/Tabla/Drum, Stop/Start and beat accuracy against a recording if possible.
5. Exercise 10 minutes with and without challenge timer; verify that idle UI CPU returns to baseline.
6. Test Ear Tuner continuous natural loop and beep, Stop and note changes.
7. Test Sound Tuner and Scale Practice microphone, then lock the screen. Capture should stop and reopen correctly after unlock and a new Start.
8. Repeat 20-minute Tanpura and Metronome sessions with the phone unplugged and standard battery-saver settings; inspect regressions.

Example ADB snapshots, when a development phone is connected:

```bash
adb shell dumpsys battery | grep -Ei 'temperature|level|status'
adb shell dumpsys cpuinfo | grep -i vio
adb shell dumpsys gfxinfo com.anuppaul.vio | head -70
adb shell pidof com.anuppaul.vio
```

Battery temperature reported by Android is not necessarily SoC temperature, and it varies by phone. CPU, GPU workload, brightness, battery temperature, charge state and ambient conditions must be interpreted together.

## Release gate

**Source fixes committed. No GitHub Actions build or physical APK thermal acceptance was run by this change.** Do not call the fix proven until local APK compile and 20-minute device comparisons pass. Keep `main` unchanged until then.
