# Android Sound Tuner Native Audio Backend

VIO's Android Sound Tuner uses a native-first capture architecture while keeping the existing Java capture path as a compatibility fallback.

## Backend order

At tuner start:

1. Load `libvio_audio.so`.
2. Try Oboe with the device's native sample rate.
3. Prefer low-latency exclusive input.
4. Prefer the unprocessed input preset.
5. Retry voice-recognition preset if unprocessed cannot open.
6. Retry shared mode if exclusive mode cannot open.
7. If Oboe still cannot start, fall back to the existing Java `AudioRecord` implementation.

The pitch DSP stays in `NativePitchPlugin.java` for this phase. Only microphone capture moves to Oboe, which keeps the detector/fusion behavior comparable with the previous native implementation.

## Oboe version

The Android module pins:

```text
com.google.oboe:oboe:1.11.0
```

VIO uses the Prefab package through CMake. Oboe 1.11.0 is the September 2026 stable release and includes the NDK 30 compilation fixes from the upstream release.

## Native stream request

The Oboe backend requests:

- input direction
- mono
- float PCM exposed to the VIO callback
- format conversion allowed so older/legacy input paths can still use their optimal hardware format
- low-latency performance mode
- exclusive sharing first, shared fallback
- unprocessed preset first, voice-recognition fallback
- no forced sample rate

Not forcing a sample rate lets Oboe/AAudio select the device-native path instead of introducing avoidable sample-rate conversion.

## Real-time boundary

The Oboe data callback is intentionally minimal:

```text
Oboe input callback
  -> preallocated 65,536-frame float ring
  -> atomic write index
  -> return
```

The callback does not:

- allocate memory
- call JNI
- run pitch detection
- lock a mutex
- sleep
- perform file/network operations

The existing Java DSP worker reads chunks from the native ring through JNI outside the real-time callback.

When the Java consumer falls behind, the native callback does not block. New frames are dropped and counted rather than stalling the audio thread.

## Diagnostics

The Capacitor `NativePitch.start()` response includes:

- `sampleRate`
- `source`
- `backend`: `oboe` or `audiorecord`
- `framesPerBurst`
- `bufferCapacityFrames`
- `droppedFrames`
- `oboeAvailable`
- `oboeFallbackErrorCode`

The Sound Tuner displays `Native Oboe` or `Native AudioRecord` so physical-device testing can immediately identify which capture path is active.

A successful Oboe source string is shaped like:

```text
oboe-aaudio-exclusive-low-latency-unprocessed
```

Actual API/sharing mode are reported from the opened stream, not assumed from the request.

## Build requirements

The checked-in Android module now contains C++ code under:

```text
android/app/src/main/cpp/
```

Android builds therefore require the Android NDK and CMake 3.22.1-compatible tooling. Gradle's external-native-build integration and Prefab resolve the Oboe headers/library.

Native build outputs under `android/.cxx/` and `android/app/.cxx/` are ignored.

## Fallback boundary

Failure to load the native library or open an Oboe stream does not disable the tuner. VIO falls back to the previous `AudioRecord` path.

If an already-running Oboe stream is disconnected, the native worker reports the capture failure to the existing Sound Tuner error path. Automatic route recovery is a separate acceptance/hardening phase because reconnect behavior must be tested on physical devices (wired headset, USB, Bluetooth, calls, and device route changes).

## Acceptance still required

This source integration has to be checked on physical Android devices before Oboe becomes a measured production win. Important measurements:

- actual backend selected
- actual sample rate
- frames per burst
- time to first stable note
- note-switch latency
- dropped native ring frames
- tuner cents jitter
- disconnect/reconnect behavior
- battery/CPU impact
- behavior on API 24–26 OpenSL ES fallback versus API 27+ AAudio

Do not infer lower latency merely from the backend name; measure it.
