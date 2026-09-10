export type YinResult = { frequency: number; clarity: number } | null;

export function detectYin(
  samples: Float32Array,
  sampleRate: number,
  minFreq = 150,
  maxFreq = 1800,
  threshold = 0.16
): YinResult {
  const n = samples.length;
  if (!n || !sampleRate) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxTau = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2) - 1);
  if (maxTau <= minTau) return null;

  const diff = new Float32Array(maxTau + 1);
  const cmnd = new Float32Array(maxTau + 1);

  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    const limit = n - tau;
    for (let i = 0; i < limit; i++) {
      const d = samples[i] - samples[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate < 0) {
    let best = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau++) {
      if (cmnd[tau] < cmnd[best]) best = tau;
    }
    if (cmnd[best] > 0.45) return null;
    tauEstimate = best;
  }

  let refined = tauEstimate;
  if (tauEstimate > minTau && tauEstimate < maxTau) {
    const y0 = cmnd[tauEstimate - 1];
    const y1 = cmnd[tauEstimate];
    const y2 = cmnd[tauEstimate + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) refined += 0.5 * (y0 - y2) / denom;
  }

  const frequency = sampleRate / refined;
  if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) return null;

  return {
    frequency,
    clarity: Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]))
  };
}
