# Sound Tuner Regression

The tuner regression harness exercises the same core building blocks used by the live Sound Tuner:

- Pitchy 8192 / 4096 / 2048 estimators
- multi-resolution YIN/NSDF
- McLeod Pitch Method (MPM)
- harmonic-series scoring and hum penalties
- confidence composition
- `PitchTracker` attack, lock, transition, dropout and release states

It uses deterministic synthetic violin-like signals so the same detector change can be compared repeatedly.

## Manual run

This is intentionally not wired to CI.

```bash
node scripts/run-tuner-regression.mjs
```

Machine-readable report:

```bash
node scripts/run-tuner-regression.mjs --json
```

The runner compiles only the regression entry and its TypeScript dependencies into a temporary directory, runs the report, then removes the temporary output.

## Static cases

The current fixture set includes:

- A4 pure sine
- A4 violin-like harmonic stack
- D4 with weak fundamental and strong overtones
- G3 bowed vibrato
- E5 strong-second-harmonic octave trap
- A4 with 50 Hz mains hum
- A4 with broadband room noise
- hum-only rejection
- broadband-noise rejection

For pitched cases the report records final frequency/note, cents error, first-lock latency, octave-error frames and false-positive frames.

## Temporal cases

The full engine also checks:

- A4 → B4 switching latency
- brief dropout hold and recovery
- note release → idle
- persistent 50 Hz hum remaining unpitched

## Interpretation

A passing synthetic report is a regression gate, not proof of real-world accuracy. Real violin recordings and physical Android devices are still required before calibration thresholds should be considered final.

## Real audio benchmark

For annotated WAV recordings, device/dataset grouping, lock latency, cents distributions and false-positive measurement, see `docs/TUNER_AUDIO_BENCHMARK.md`.
