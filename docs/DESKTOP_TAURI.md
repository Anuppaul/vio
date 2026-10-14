# VIO desktop: Tauri 2

Desktop packaging is isolated from the existing hosted web/PWA and Android Capacitor builds.

- Tauri Rust core: 2.12.3 (pinned)
- Tauri CLI: 2.12.2 (pinned in package.json)
- Target installers: Ubuntu amd64 .deb and Windows x64 NSIS .exe
- Uses bundled local HTML, JS, CSS and audio; no hosted Next server at runtime.

## Build

Install Node.js 22+, Rust and the official Tauri 2 OS prerequisites. On Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
npm install
npm run build:desktop:web
npx tauri build --bundles deb
```

On Windows, install Rust (MSVC toolchain), Visual Studio C++ build tools, and WebView2, then:

```powershell
npm install
npx tauri build --bundles nsis
```

Output directories:

- `src-tauri/target/release/bundle/deb/`
- `src-tauri/target/release/bundle/nsis/`

GitHub Actions `Build VIO Desktop` runs the two builds in parallel and uploads 14-day artifacts. Windows packaging occurs on a Windows runner: Linux does not cross-compile the NSIS executable.

## Important verification gates

- Confirm six local navigation routes work in Linux WebKitGTK and Windows WebView2.
- Confirm Sound Tuner and Scale Practice microphone permission, pitch latency and A4 detection on both OSes.
- Check playback of Ear Tuner, Tanpura, exercises and Metronome with no network.
- Verify correct offline start, restart, installer upgrade and uninstall.
- Unsigned Windows installers may trigger SmartScreen; signing requires a code-signing certificate.
- The Android Oboe backend is Android-only. Desktop uses web microphone capture.
- This is source and CI packaging setup, not evidence of a successful installer build or physical microphone acceptance.
