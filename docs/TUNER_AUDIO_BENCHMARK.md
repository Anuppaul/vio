# Real-Audio Sound Tuner Benchmark

This benchmark evaluates the **full VIO Sound Tuner engine** against annotated WAV recordings.

It is deliberately separate from CI. Add real recordings locally, annotate the expected pitched/unpitched regions, and run the benchmark manually.

## Supported audio

The local decoder supports standard RIFF/WAVE files with:

- PCM 8-bit
- PCM 16-bit
- PCM 24-bit
- PCM 32-bit
- IEEE float 32-bit
- IEEE float 64-bit
- mono or multichannel audio; multichannel files are downmixed to mono

WAVE_FORMAT_EXTENSIBLE PCM/float subtypes are accepted. RF64 is rejected explicitly instead of being parsed incorrectly.

The benchmark keeps the recording's native sample rate so 32 kHz, 44.1 kHz, 48 kHz, and other device rates exercise the tuner's sample-rate-aware logic.

## Files

Copy the example manifest:

```bash
cp benchmarks/tuner/manifest.example.json benchmarks/tuner/manifest.json
```

Put local recordings under:

```text
benchmarks/tuner/fixtures/
```

The fixture and result directories are gitignored so large/private recordings are not accidentally committed.

## Manifest

A recording has an ID, WAV path, optional tags/metadata, and sorted non-overlapping annotation regions.

A voiced region must specify exactly one of:

- `expectedHz`
- `expectedMidi`

Example:

```json
{
  "id": "open-strings-phone-a",
  "file": "fixtures/open-strings-phone-a.wav",
  "tags": [
    "instrument:violin",
    "articulation:arco",
    "device:phone-a"
  ],
  "regions": [
    {
      "id": "background",
      "startMs": 0,
      "endMs": 500,
      "voiced": false
    },
    {
      "id": "g3",
      "startMs": 700,
      "endMs": 2200,
      "voiced": true,
      "expectedMidi": 55,
      "toleranceCents": 20,
      "ignoreAttackMs": 80
    }
  ]
}
```

### Defaults

`defaults` may define:

- `a4`: reference pitch; default 440 Hz
- `hopSize`: optional fixed benchmark hop in samples. If omitted, VIO derives the same ~21.3 ms sample-rate-aware hop used by the web AudioWorklet
- `toleranceCents`: fine-pitch pass band for voiced frames; default 20 cents
- `ignoreAttackMs`: excludes initial attack frames from accuracy/dropout scoring

`ignoreAttackMs` does **not** hide lock latency. Lock latency is measured from the actual region start.

## Metrics

For voiced regions:

- **fine accuracy**: fraction of scored frames inside the requested cents tolerance
- **note accuracy**: fraction of scored frames mapped to the correct chromatic note
- **detection rate**: fraction of scored frames with a tuner pitch
- **dropout rate**: fraction of scored frames with no tuner pitch
- cents MAE / median / p95
- lock latency
- octave-error rate
- gross-error rate (>100 cents and not classified as an octave error)

For unvoiced regions:

- false-positive frames
- false-positive rate

The benchmark profile is reported as `web-primary`: it models the current web/PWA detector cadence (fast/short each frame, adaptive long-window cadence, ~96 ms independent consensus cadence). Android native behavior still requires its own physical-device acceptance tests.

The report also aggregates by recording and by arbitrary tags such as:

```text
device:pixel
device:samsung
articulation:arco
articulation:pizzicato
dynamic:pp
dynamic:ff
source:good-sounds
```

This makes it possible to see whether accuracy is specifically weak on one phone, articulation, dynamic, or dataset.

## Run

Human-readable report:

```bash
node scripts/run-tuner-audio-benchmark.mjs \
  --manifest benchmarks/tuner/manifest.json
```

JSON:

```bash
node scripts/run-tuner-audio-benchmark.mjs \
  --manifest benchmarks/tuner/manifest.json \
  --json
```

Every report records the current Git commit, manifest SHA256, and each WAV SHA256 so benchmark runs can be compared against the exact engine/data revision.

Write reports:

```bash
node scripts/run-tuner-audio-benchmark.mjs \
  --manifest benchmarks/tuner/manifest.json \
  --out benchmarks/tuner/results/report.json \
  --csv benchmarks/tuner/results/regions.csv
```

Run only selected recordings:

```bash
node scripts/run-tuner-audio-benchmark.mjs \
  --manifest benchmarks/tuner/manifest.json \
  --only open-strings-phone-a,chromatic-arco-phone-a
```

## Optional acceptance criteria

Without `criteria`, the benchmark is **report-only** and does not claim PASS/FAIL.

When acceptance targets are known, the manifest may add:

```json
{
  "criteria": {
    "minVoicedFrameAccuracy": 0.90,
    "minVoicedNoteAccuracy": 0.97,
    "minVoicedDetectionRate": 0.95,
    "maxDropoutRate": 0.05,
    "maxVoicedCentsMae": 10,
    "maxVoicedCentsP95": 25,
    "maxOctaveErrorRate": 0.01,
    "maxGrossErrorRate": 0.02,
    "maxUnvoicedFalsePositiveRate": 0.02,
    "minLockSuccessRate": 0.98,
    "maxMedianLockMs": 250
  }
}
```

Those numbers are **illustrative schema examples, not calibrated VIO production thresholds**. Production thresholds should be frozen only after a representative real-violin dataset and physical-phone test set have been measured.

## Annotation guidance

For useful measurements:

1. Include unvoiced room/background regions before and after notes.
2. Keep note boundaries as accurate as practical.
3. Use `ignoreAttackMs` only for accuracy scoring when bow attack is intentionally unstable.
4. Do not use `ignoreAttackMs` to make lock latency look better; lock timing ignores that grace period.
5. Include difficult material: weak fundamentals, strong harmonics, vibrato, pizzicato, pp/ff dynamics, fan/hum/noise, and rapid note changes.
6. Tag device and recording conditions consistently so the by-tag report is meaningful.

A synthetic PASS plus a real-audio PASS still does not replace physical Android acceptance testing; it provides a reproducible measurement layer for deciding what to fix next.
