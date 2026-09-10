VIOLIN TOOLS SUITE + NOTE READING EXERCISE
==========================================

Pages
-----
- index.html          Ear Tuner
- sound-tuner.html    Microphone / pitch tuner
- tanpura.html        Tanpura
- exercise.html       Note Reading Exercise

Exercise features
-----------------
- Treble, Bass, Alto and Tenor clefs
- Easy / Standard / Extended / Wide staff ranges
- Major key signatures from 7 sharps through 7 flats
- Naturals, sharps, flats and written natural cancellation
- C-D-E-F-G-A-B note filter
- First-attempt scoring, streak and accuracy
- Multiple-attempt and auto-advance options
- Question-limited and timed Challenge Mode
- Reveal / new question / progress report
- Keyboard shortcuts: A-G, Arrow Up/Down, Shift+R/N/P
- Local tone playback with Web Audio fallback
- Responsive desktop/mobile UI

Exercise tones
--------------
61 local WAV files (MIDI 36..96 / C2..C7) are already included under:
    assets/exercise/

To regenerate them at any time:
    node generate_exercise_tones.js

The generator uses Node.js built-ins only. It installs nothing and does not need
Firefox, Playwright, npm packages, ffmpeg or network access.

Running locally
---------------
Static pages can be opened directly. For the microphone Sound Tuner, use a local
HTTP server so the browser grants microphone permission:

    python3 -m http.server 8080

Then open:
    http://localhost:8080/

Existing Tanpura / violin MP3s
------------------------------
If you already downloaded your Tanpura or violin MP3 files locally, keep those
existing assets folders. Extract/copy this package over the existing suite rather
than deleting your old assets first.

NEW CANDY UI / METRONOME
------------------------
- Shared 5-tab navigation: Ear Tuner, Sound Tuner, Tanpura, Exercise, Metronome.
- Ear Tuner and Tanpura received a professional soft/candy UI redesign.
- metronome.html uses Web Audio look-ahead scheduling (not setInterval timing).
- Metronome supports 30-300 BPM, tap tempo, 1-7 beats/bar, quarter/eighth/triplet/sixteenth subdivisions,
  first-beat accent, visual flash, and local Click / Tabla / Drum sound modes.
- Metronome local sounds are under assets/metronome/ and have no remote dependency.

IMPORTANT: if you already generated your real Tanpura recordings, keep your existing
assets/tanpura/tanpura_manifest.js and MP3 files when overlaying this package.
