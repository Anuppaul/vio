# Changelog

This file tracks source-level changes. It does not certify that old APK files in `release/` include every later update.

## Unreleased

### Added
- Native Android foreground audio service for screen-off Tanpura, Metronome and Ear Tuner playback, with notification controls.
- Android native capture/backend documentation, regression tests and explicit thermal checks.
- MIT code license, open-source community files, source architecture documentation and original SVG README artwork.

### Improved
- Reduced unnecessary Android audio/GPU work, decoded PCM retention, stale oscillators, and forced display wake.
- Better Android audio lifecycle and source verification.

### Known release blockers
- Some bundled Tanpura and Ear Tuner recordings have unresolved redistribution rights; see [Asset licensing](docs/ASSET_LICENSING.md).
- Dependency security advisories require remediation before a secure official release.

## 1.0.0 — historical local builds

The repository contains historical VIO `1.0.0` Android test packages. Their presence is **not** an official release or a statement that they include current screen-off audio support, security fixes, or redistribution-cleared sound assets.
