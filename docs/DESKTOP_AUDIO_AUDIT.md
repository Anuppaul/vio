# VIO Desktop audio audit — Ubuntu 24.04 / Tauri 2

## Scope and verification boundary

This patch is source-level remediation of installed Linux WebKitGTK audio:
- Microphone permission alone is insufficient: enable WebKitGTK's media-stream
  and WebRTC settings on VIO's local window in Tauri setup. The Rust
  `webkit2gtk` dependency pins 2.0.2 with feature `v2_38` because the
  WebRTC setting is feature-gated; an unfeatured import does not compile.
- Preserve microphone-only permission for VIO's bundled origin. Camera and screen
  capture remain denied; do **not** disable WebView security.
- Keep Sound Tuner / Scale Practice analyzers attached to a zero-gain output node
  so native WebKit continues pulling frames if AudioWorklet is unavailable.
- Unlock AudioContext in a real Start/Play gesture; report timeouts and errors.
- Avoid opening/resuming Metronome output before user interaction.
- Make every Metronome sound selection audible even when a WAV sample fails to
  decode, using the existing synthesized click.
- Surface playback errors in Ear Tuner, Tanpura, Sound Tuner references and
  Exercise. Cap Exercise wait-for-audio so practice does not freeze.
- Explicitly enable WebKitGTK HTML media + WebAudio and require WebKitGTK / GStreamer
  runtime libraries in the Ubuntu .deb.

**No GitHub Actions have been run to verify this change.** The desktop workflow
has ONLY `workflow_dispatch` and must remain manual-only until the owner
explicitly authorizes a new build run. Android and hosted-web release
workflows were not triggered.

## Required local preflight

On Ubuntu 24.04, with the full checked-out source:

```bash
git switch feature/tauri2-desktop
git pull --ff-only
npm run audit:desktop:audio
npm ci
npm run desktop:icons
npm run build:desktop:web
npm run test:desktop:web   # Chromium simulation only; NOT a native WebKit test
```

Use a local Tauri build (not GitHub Actions) for real WebKitGTK testing:

```bash
npm run desktop:build -- --bundles deb
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
vio
```

The Debian package is configured to depend on WebKitGTK, GTK and the GStreamer
base/good/bad/libav/PulseAudio plugins. On Ubuntu the available plugins can be
checked with:

```bash
gst-inspect-1.0 autoaudiosink
gst-inspect-1.0 pulsesrc
gst-inspect-1.0 mpg123audiodec
wpctl status
```

`gst-inspect-1.0` is provided by `gstreamer1.0-tools` (install manually for
diagnostics if absent). The exact decoder element may vary by distro.

## Native on-device acceptance

Open **Sound Tuner → Desktop Audio Check**.

1. **WebView capabilities**: secure local origin; getUserMedia and AudioContext
   exist; codecs report support only as a hint, not proof.
2. **440 Hz speaker beep**: must be audibly heard (the code can only prove the
   oscillator was scheduled).
3. **MP3 reference + MP3 Tanpura**: each sample must decode and be audible.
4. **WAV metronome + WAV exercise**: both must decode and be audible.
5. **Microphone 6s**: grant access, play/sing A4, check nonzero level and
   approximate 440 Hz output. No microphone audio is saved or uploaded.
6. Test actual **Sound Tuner** detection, note transitions, stop/restart and
   **Scale Practice** reference capture. Test unplug/replug or input change.
7. Test Metronome Click, Tabla and Drum at different tempos; check audible output,
   responsiveness after repeated Start/Stop and offline operation.
8. Run all above with network disabled, then recheck after reboot/reinstallation.

## Troubleshooting installed .deb

Open a terminal and launch `vio`. Inspect messages **without** permanently
changing system-wide browser security:

```bash
GST_DEBUG=2 vio 2>&1 | tee /tmp/vio-audio-debug.log
```

If application menus start VIO but audio is silent, verify the system's default
output and input in Ubuntu Settings and `wpctl status`. If audio capture is
denied, check the app's Audio Check environment, microphone permission status,
PipeWire/PulseAudio sources, and any GStreamer plugin errors shown above.

Do not use `WEBKIT_DISABLE_WEB_SECURITY`, disable certificate checks, or give
arbitrary remote pages microphone permission to work around audio issues.

## What is still NOT proven

- The Rust/TypeScript changes need a local compiler/build execution.
- Test results from Playwright Chromium **cannot** establish the behavior of
  the installed Ubuntu WebKitGTK engine or real microphone/speaker.
- Hardware latency, MP3 decoding, audio-device routing, Bluetooth and USB
  microphone behavior need on-device acceptance.
- Windows WebView2 must also be verified before calling the desktop release
  production-ready.

Repository changes are development-stage only; do not promote to `main` yet.
