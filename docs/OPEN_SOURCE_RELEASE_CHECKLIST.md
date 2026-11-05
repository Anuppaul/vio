# Open-source release checklist

The repository can be public without being ready for unrestricted redistribution of every file. Treat this checklist as a **release gate**, not a claim that all checks are already satisfied.

## Ownership & permissions

- [x] The repository is under the personal GitHub account **Anuppaul**.
- [x] The project source is offered under an explicit MIT LICENSE.
- [x] The project's original SVG documentation artwork is attributed to **Anuppaul**.
- [ ] **BLOCKER:** Clear or replace all bundled Tanpura recordings currently documented as captured from Spardha School of Music.
- [ ] **BLOCKER:** Verify the license/source of the downloaded Ear Tuner MP3 files.
- [ ] Audit original authorship and any underlying sample sources for metronome/exercise sounds.
- [ ] Confirm VIO launcher/icon rights before a full artwork MIT grant.
- [ ] Audit source history and previously published APKs for uncleared audio; remove/rebuild and coordinate history cleanup if needed.
- [ ] Obtain third-party dependency SPDX/license export for npm + Gradle + NDK/Oboe before publishing an official release.

## Security & dependencies

- [x] Document private vulnerability reporting.
- [x] Ignore `.env*`, Java keystores and SDK/local configuration.
- [ ] **BLOCKER:** Resolve known `npm audit` findings. A previous Android CI attempt failed during the dependency audit; it included critical Next.js advisories, a Sharp advisory, and transitive dependency advisories. Do **not** disable the security gate merely to publish a binary.
- [ ] Confirm all tracked files and full Git history are free from credentials, personal data, API tokens, certificates, and build machine paths.
- [ ] Enable GitHub secret scanning, code scanning/Dependabot, and branch protection appropriate to a public repository.
- [ ] Validate Android exported components, URI handlers, permissions, backup policies and media foreground-service behaviour across supported Android versions.

## QA & distribution

- [x] Keep Android GitHub Actions **manual-only**.
- [x] Commit source regression tests and Android background-playback documentation.
- [ ] Run `npm ci`, `npm run build`, regression checks and real Android compilation from a clean checkout.
- [ ] Test source builds without private credentials or unavailable proprietary assets.
- [ ] Check screen-off audio timing, notification controls, Bluetooth routing, microphone access, airplane mode, battery/heat, and Android API 24+ compatibility on target devices.
- [ ] Use a **stable privately stored signing key** for release APKs/AABs. Never include the key in Git or Colab outputs.
- [ ] Tag a release and publish the corresponding binaries to **GitHub Releases** only after licensing/security gates pass; clearly distinguish debug APKs from production packages.
- [ ] Update version names/codes and CHANGELOG with tested changes.

## GitHub presentation

- [x] Professional SVG README and architecture diagrams.
- [x] MIT LICENSE, attribution/asset notice, contribution/community/security docs.
- [x] Issue templates and PR template.
- [x] Dependabot update PRs for npm, Gradle and GitHub Actions.
- [ ] Set the repository About description and topic tags in GitHub Settings (e.g. `violin`, `music-education`, `metronome`, `pitch-detection`, `android`, `nextjs`, `open-source`).
- [ ] Enable GitHub Discussions if desired and verify private vulnerability reporting is enabled.

> Until the above blockers are resolved, **do not describe existing APK binaries or recorded audio assets as fully MIT-licensed or an official redistribution-cleared release**.
