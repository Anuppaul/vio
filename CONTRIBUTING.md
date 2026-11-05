# Contributing to VIO

Thanks for contributing to **VIO**, an independent music-practice project maintained by **[Anuppaul](https://github.com/Anuppaul)**.

## Before you start

Read the [Code of Conduct](CODE_OF_CONDUCT.md), [Security Policy](SECURITY.md), and especially [Audio asset licensing](docs/ASSET_LICENSING.md). Please search existing issues and pull requests before starting a large change.

A useful contribution improves actual musicians' ability to practise: tuning precision, scale exercises, latency, background playback, clear UX, accessibility, privacy, battery efficiency, bug fixes or documentation.

## Development

Requires Node.js 22 and npm. Local web development:

```bash
git clone https://github.com/Anuppaul/vio.git
cd vio
npm ci
npm run dev
```

Create a branch from the current `main`, using a descriptive name such as `fix/tuner-note-lock` or `feat/accessibility-labels`.

### Checks before a pull request

```bash
npm run build
node scripts/run-tuner-regression.mjs
npm run test:android:thermal
npm run test:android:background
```

For changes to Capacitor, Android plugins or native audio, also run `npm run android:apk` from a configured Android environment and test on a physical phone. Do not assume Chromium browser tests prove native WebView or microphone behaviour. Android build prerequisites are in the [README](README.md#android-apk).

For a web export smoke test:

```bash
npm run build:android:web
npx playwright install chromium
npm run test:android:web
```

### Pull request guidelines

- Keep PRs focused and describe **what changed, why, and which platforms it affects**.
- Include reproduction instructions and the exact device/Android version for hardware issues.
- Include test output, audio timing measurements, or screen recordings when appropriate, but **never include private microphone recordings without informed permission**.
- For pitch-tracking changes, explain how latency, octave errors, cents jitter and false positives are affected.
- For performance changes, describe baseline, device, sample length, battery/CPU assumptions and measurement method.
- Don't add generated build outputs, signing keystores, debug recordings, secret files, or large binary APKs to a code PR.
- Never manually start GitHub Actions just to make a documentation change; the Android workflow is deliberately opt-in.

## Audio and image contributions

**No external audio file is accepted without a verifiable grant.** Provide author, origin, permission/license, and a reproducible generator where possible. The currently documented Tanpura and Ear Tuner recording provenance is **not cleared**. Replacing those assets with independently recorded/synthesized, well-looped audio is a high-priority contribution.

By submitting original contributions you agree they may be redistributed under the repository's MIT License unless a file-level license explicitly says otherwise. Only submit content you own or are authorized to relicense; don't copy snippets/audio from other repositories without verifying their terms.

## Community expectations

Be precise, respectful, and helpful. Critique implementations and evidence, not contributors. For security-sensitive disclosures, follow [SECURITY.md](SECURITY.md) rather than posting working exploits in public issues.
