export const SA_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function saFrequency(note: string) {
  return 130.81278265 * 2 ** (SA_KEYS.indexOf(note) / 12);
}
