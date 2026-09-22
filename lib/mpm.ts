export type MpmPitchResult = {
  frequency: number;
  clarity: number;
};

type Workspace = {
  size: number;
  maxTau: number;
  prefixEnergy: Float64Array;
  nsdf: Float64Array;
};

const workspaces = new Map<number, Workspace>();

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getWorkspace(size: number, maxTau: number) {
  let workspace = workspaces.get(size);
  if (!workspace || workspace.maxTau < maxTau) {
    workspace = {
      size,
      maxTau,
      prefixEnergy: new Float64Array(size + 1),
      nsdf: new Float64Array(maxTau + 2)
    };
    workspaces.set(size, workspace);
  }
  return workspace;
}

function parabolicPeak(values: ArrayLike<number>, index: number) {
  if (index <= 0 || index >= values.length - 1) return index;
  const left = values[index - 1];
  const center = values[index];
  const right = values[index + 1];
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-12) return index;
  const offset = 0.5 * (left - right) / denominator;
  return index + Math.max(-1, Math.min(1, offset));
}

/**
 * McLeod Pitch Method style normalized square difference detector.
 *
 * The NSDF score remains close to 1 for a clean repeating period and naturally
 * exposes a useful clarity measure. We select the earliest strong key maximum
 * relative to the best peak so that the fundamental period wins over later
 * repeated periods while weak harmonic sub-periods are rejected.
 */
export function detectMpm(
  samples: Float32Array,
  sampleRate: number,
  minFrequency = 55,
  maxFrequency = 2000,
  peakRatio = 0.90,
  minimumClarity = 0.55
): MpmPitchResult | null {
  const size = samples.length;
  if (
    size < 512 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !(maxFrequency > minFrequency)
  ) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxTau = Math.min(
    Math.floor(sampleRate / minFrequency),
    Math.floor(size / 2) - 2
  );
  if (maxTau <= minTau) return null;

  const workspace = getWorkspace(size, maxTau);
  const { prefixEnergy, nsdf } = workspace;

  let mean = 0;
  for (let i = 0; i < size; i++) mean += samples[i];
  mean /= size;

  prefixEnergy[0] = 0;
  for (let i = 0; i < size; i++) {
    const value = samples[i] - mean;
    prefixEnergy[i + 1] = prefixEnergy[i] + value * value;
  }

  nsdf[0] = 1;
  let strongest = 0;
  const peaks: number[] = [];

  for (let tau = 1; tau <= maxTau; tau++) {
    const limit = size - tau;
    let correlation = 0;
    for (let i = 0; i < limit; i++) {
      correlation += (samples[i] - mean) * (samples[i + tau] - mean);
    }

    const leftEnergy = prefixEnergy[limit];
    const rightEnergy = prefixEnergy[size] - prefixEnergy[tau];
    const denominator = leftEnergy + rightEnergy;
    nsdf[tau] = denominator > 1e-12
      ? Math.max(-1, Math.min(1, (2 * correlation) / denominator))
      : 0;
  }

  for (let tau = minTau + 1; tau < maxTau; tau++) {
    const value = nsdf[tau];
    if (value <= 0) continue;
    if (value >= nsdf[tau - 1] && value > nsdf[tau + 1]) {
      peaks.push(tau);
      if (value > strongest) strongest = value;
    }
  }

  if (!peaks.length || strongest < minimumClarity) return null;

  const cutoff = Math.max(minimumClarity, strongest * peakRatio);
  let selected = -1;

  for (const peak of peaks) {
    if (nsdf[peak] >= cutoff) {
      selected = peak;
      break;
    }
  }

  if (selected < 0) {
    selected = peaks.reduce((best, peak) =>
      nsdf[peak] > nsdf[best] ? peak : best
    , peaks[0]);
  }

  const refinedTau = parabolicPeak(nsdf, selected);
  const frequency = sampleRate / refinedTau;
  if (
    !Number.isFinite(frequency) ||
    frequency < minFrequency ||
    frequency > maxFrequency
  ) return null;

  return {
    frequency,
    clarity: clamp01(nsdf[selected])
  };
}
