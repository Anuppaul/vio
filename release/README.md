# VIO — historical Android build artifacts

> **These APKs are historical local/test artifacts, not current official VIO releases.**
> The files here predate some of the current Android screen-off audio and thermal fixes. They may contain **uncleared third-party sound recordings**. The repository's [MIT LICENSE](../LICENSE) **does not grant rights to those recordings**. Do not mirror or redistribute these binaries until rights and build provenance have been cleared. See [Audio asset licensing](../docs/ASSET_LICENSING.md).

## Existing files

- `vio-1.0.0-debug.apk`: historically committed debug/test build, signed with a development key; not a Play Store release.
- `vio-1.0.0-release.apk`: historically committed release-mode build; signing key continuity and the rights of bundled audio must be verified before redistribution.
- `*.sha256`: hashes for their corresponding historical APKs.
- `build-*.json`: build metadata for the associated binaries.
- `test-results/`: browser smoke-test reports; **not** physical-device certification.

**Do not assume these files were compiled from the current `main` commit.** Reproducible build metadata should point to an explicit commit SHA and a verifiable signing key fingerprint.

## Build locally

With Node.js 22, JDK 21, Android SDK API 36 and Build Tools 36.0.0, compatible NDK/CMake and FFmpeg installed:

```bash
npm ci
npm run test:android:thermal
npm run test:android:background
npm run android:apk
```

The build creates an offline Android export, syncs Capacitor, runs Gradle, checks signing, and copies a debug APK plus checksum into `release/`.

For a release-mode build, set the private `VIO_KEYSTORE_PATH`, `VIO_KEYSTORE_PASSWORD`, `VIO_KEY_ALIAS`, `VIO_KEY_PASSWORD`, and monotonically increasing `VIO_VERSION_CODE` in your local environment. Never commit signing files or paste their credentials into GitHub issues, logs or chat.

## Publishing policy

VIO Android's GitHub Actions workflow is intentionally **manual-only**. It has an optional publish job that can commit artifacts back to `main` after a successful manual run. **The publish job is currently disabled unless repository variable `VIO_ASSETS_CLEARED` is explicitly set to `true` after the licensing/security review.** Do not set it while the blockers remain. Official tagged binaries should ultimately be distributed through **GitHub Releases**, with a signed APK, checksum, source revision, release notes and a recorded asset license audit.

See [the release checklist](../docs/OPEN_SOURCE_RELEASE_CHECKLIST.md) and [the Android background-audio documentation](../docs/ANDROID_SCREEN_OFF_AUDIO.md).
