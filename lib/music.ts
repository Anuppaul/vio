export const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
export const FLAT_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
export const OPEN_STRINGS = [55, 62, 69, 76] as const;
export const NOTE_RANGE_MIN_MIDI = 24;  // C1
export const NOTE_RANGE_MAX_MIDI = 103; // G7

export function midiFrequency(midi: number, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidiFloat(frequency: number, a4 = 440) {
  return 69 + 12 * Math.log2(frequency / a4);
}

export type FrequencyRange = {
  midi: number;
  note: string;
  octave: number;
  label: string;
  target: number;
  low: number;
  high: number;
};

/**
 * Exact equal-temperament note ranges from C1 through G7.
 * Each boundary is the geometric midpoint (±50 cents) between adjacent notes.
 * At A4=440 this matches the supplied chart, e.g.:
 * D4 target 293.66 Hz, range 285.30–302.27 Hz.
 */
export function buildFrequencyRanges(a4 = 440): FrequencyRange[] {
  const ranges: FrequencyRange[] = [];
  for (let midi = NOTE_RANGE_MIN_MIDI; midi <= NOTE_RANGE_MAX_MIDI; midi++) {
    const note = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    const target = midiFrequency(midi, a4);
    ranges.push({
      midi,
      note,
      octave,
      label: `${note}${octave}`,
      target,
      low: midiFrequency(midi - 0.5, a4),
      high: midiFrequency(midi + 0.5, a4)
    });
  }
  return ranges;
}

export function noteFromFrequencyRange(frequency: number, a4 = 440) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const ranges = buildFrequencyRanges(a4);
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (frequency < range.low) hi = mid - 1;
    else if (frequency >= range.high) lo = mid + 1;
    else {
      const cents = 1200 * Math.log2(frequency / range.target);
      return { ...range, frequency, cents };
    }
  }
  return null;
}

export function noteFromFrequency(frequency: number, a4 = 440) {
  const ranged = noteFromFrequencyRange(frequency, a4);
  if (ranged) return ranged;
  const midiFloat = frequencyToMidiFloat(frequency, a4);
  const midi = Math.round(midiFloat);
  const target = midiFrequency(midi, a4);
  const cents = 1200 * Math.log2(frequency / target);
  return {
    midi,
    note: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    label: `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`,
    frequency,
    target,
    low: midiFrequency(midi - 0.5, a4),
    high: midiFrequency(midi + 0.5, a4),
    cents
  };
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b) => a-b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function rms(buffer: Float32Array) {
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return Math.sqrt(sum / buffer.length);
}
