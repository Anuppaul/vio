Exercise assets
===============

Run from the suite root:

  node generate_exercise_tones.js

This creates local WAV tone files for MIDI 36..96 and regenerates tone_manifest.js.
No npm packages, browser, Playwright, Firefox extension, or ffmpeg are required.

The Exercise page uses the local files when present and falls back to browser Web Audio when they are absent.
