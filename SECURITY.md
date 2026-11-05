# Security Policy

VIO handles microphone access and user-started Android background audio. Please treat security and privacy findings seriously.

## Supported code

Security fixes are targeted at the current **`main`** branch. Older committed debug/release APKs are historical test artifacts and are **not guaranteed to receive updates**. No official supported production distribution has been declared.

## Privately reporting a vulnerability

**Do not publish credentials, exploits, or user recordings in a public issue.**

Use GitHub's **Report a vulnerability** option under the repository's Security tab if private vulnerability reporting is available:

https://github.com/Anuppaul/vio/security/advisories/new

If private reporting is not enabled, contact the maintainer through a private channel or request that private reporting be enabled **without sharing technical exploit details publicly**.

A useful report includes:

- Affected branch/commit and platform (browser, PWA, or Android version).
- Reproduction steps, impact, and whether user interaction is required.
- Sanitized logs without tokens, passwords, keystores or personal media.
- Mitigation ideas if known.

Please allow a reasonable private remediation and disclosure-coordination period before publishing exploit details.

## Security boundaries

- Browser microphone use requires a user gesture and secure context.
- Android microphone capture is user-initiated and should stop when the Activity pauses.
- Native screen-off audio uses an explicit `mediaPlayback` foreground service; it is not an always-on recorder.
- APK signing secrets must never be committed or pasted into issues.
- Public source access does **not** establish redistribution rights for third-party sound recordings.

### Dependency advisories

A previous Android CI run failed `npm audit` with several open advisories, including **critical Next.js** and **high-severity Sharp** findings. **Do not bypass the dependency audit to assert a secure production release.** Update dependencies, regenerate the lockfile, and test after changes. The fact that parts of the project build and run locally is not evidence that vulnerabilities are resolved.
