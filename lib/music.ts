export const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
export const FLAT_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
export const OPEN_STRINGS = [55, 62, 69, 76] as const;

export function midiFrequency(midi: number, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidiFloat(frequency: number, a4 = 440) {
  return 69 + 12 * Math.log2(frequency / a4);
}

export function noteFromFrequency(frequency: number, a4 = 440) {
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
