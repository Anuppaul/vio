import { PitchDetector } from 'pitchy';

export const PRACTICE_PITCH_WINDOW = 8192;
export const PRACTICE_PITCH_INTERVAL_MS = 35;

export function createPracticePitchDetector() {
  const detector = PitchDetector.forFloat32Array(PRACTICE_PITCH_WINDOW);
  detector.minVolumeAbsolute = 0;
  return detector;
}
