/* GuitarTuner-style FFT + Harmonic Product Spectrum pitch detector.
   Runs off the UI thread. The original desktop tuner uses a long Hann-windowed
   microphone buffer, zero-padding, and HPS with 2x/3x spectral decimation.
   This browser port keeps that detection model and extends the search to C1-G7. */

const ZERO_PADDING = 3;
const NUM_HPS = 3;
const EPS = 1e-18;
let cachedInputSize = 0;
let cachedFftSize = 0;
let bitReverse = null;
let cosTable = null;
let sinTable = null;
let real = null;
let imag = null;
let magnitude = null;
let hann = null;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function nextPowerOfTwo(v) {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

function reverseBits(value, bits) {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | (value & 1);
    value >>>= 1;
  }
  return out;
}

function ensureWorkspace(inputSize) {
  const fftSize = nextPowerOfTwo(inputSize * (1 + ZERO_PADDING));
  if (cachedInputSize === inputSize && cachedFftSize === fftSize) return;

  cachedInputSize = inputSize;
  cachedFftSize = fftSize;
  const bits = Math.round(Math.log2(fftSize));
  bitReverse = new Uint32Array(fftSize);
  for (let i = 0; i < fftSize; i++) bitReverse[i] = reverseBits(i, bits);

  cosTable = new Float64Array(fftSize >> 1);
  sinTable = new Float64Array(fftSize >> 1);
  for (let i = 0; i < (fftSize >> 1); i++) {
    const angle = -2 * Math.PI * i / fftSize;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  real = new Float64Array(fftSize);
  imag = new Float64Array(fftSize);
  magnitude = new Float64Array((fftSize >> 1) + 1);
  hann = new Float64Array(inputSize);
  for (let i = 0; i < inputSize; i++) {
    hann[i] = inputSize > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (inputSize - 1)) : 1;
  }
}

function fftWindowed(samples) {
  ensureWorkspace(samples.length);
  real.fill(0);
  imag.fill(0);

  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;

  // Write input directly in bit-reversed order; the rest stays zero-padded.
  for (let i = 0; i < samples.length; i++) {
    real[bitReverse[i]] = (samples[i] - mean) * hann[i];
  }

  for (let len = 2; len <= cachedFftSize; len <<= 1) {
    const half = len >> 1;
    const step = cachedFftSize / len;
    for (let base = 0; base < cachedFftSize; base += len) {
      for (let j = 0; j < half; j++) {
        const tableIndex = j * step;
        const c = cosTable[tableIndex], s = sinTable[tableIndex];
        const even = base + j, odd = even + half;
        const tr = c * real[odd] - s * imag[odd];
        const ti = s * real[odd] + c * imag[odd];
        const er = real[even], ei = imag[even];
        real[even] = er + tr;
        imag[even] = ei + ti;
        real[odd] = er - tr;
        imag[odd] = ei - ti;
      }
    }
  }

  for (let i = 0; i < magnitude.length; i++) {
    magnitude[i] = Math.hypot(real[i], imag[i]);
  }
}

function logMag(bin) {
  return Math.log((magnitude[bin] || 0) + EPS);
}

function hpsScore(bin) {
  let score = 0;
  for (let h = 1; h <= NUM_HPS; h++) score += logMag(bin * h);
  return score;
}

function parabolicDelta(y0, y1, y2) {
  const den = y0 - 2 * y1 + y2;
  if (Math.abs(den) < 1e-12) return 0;
  return clamp(0.5 * (y0 - y2) / den, -1, 1);
}

function harmonicIntegerRatio(high, low) {
  if (!(high > low) || low <= 0) return 0;
  const ratio = high / low;
  const nearest = Math.round(ratio);
  if (nearest < 2 || nearest > 12) return 0;
  const cents = Math.abs(1200 * Math.log2(ratio / nearest));
  return cents <= 35 ? nearest : 0;
}

function detect(samples, sampleRate, minFreq, maxFreq) {
  fftWindowed(samples);

  const half = cachedFftSize >> 1;
  const minBin = Math.max(2, Math.ceil(minFreq * cachedFftSize / sampleRate));
  const maxDirectBin = Math.min(half - 2, Math.floor(maxFreq * cachedFftSize / sampleRate));
  const maxHpsBin = Math.min(maxDirectBin, Math.floor((half - 2) / NUM_HPS));
  if (maxHpsBin <= minBin) return null;

  let directBin = minBin, directMag = -Infinity;
  for (let bin = minBin; bin <= maxDirectBin; bin++) {
    if (magnitude[bin] > directMag) { directMag = magnitude[bin]; directBin = bin; }
  }

  let peakBin = minBin, peakScore = -Infinity;
  let secondScore = -Infinity;
  for (let bin = minBin; bin <= maxHpsBin; bin++) {
    const score = hpsScore(bin);
    if (score > peakScore) {
      secondScore = peakScore;
      peakScore = score;
      peakBin = bin;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  // Recompute the runner-up away from the main peak so adjacent FFT bins do
  // not make a strong, narrow peak look artificially ambiguous.
  secondScore = -Infinity;
  for (let bin = minBin; bin <= maxHpsBin; bin++) {
    if (Math.abs(bin - peakBin) <= 5) continue;
    const score = hpsScore(bin);
    if (score > secondScore) secondScore = score;
  }

  let chosenBin = peakBin;
  let mode = 'hps';
  const directFreq = directBin * sampleRate / cachedFftSize;
  const hpsFreq = peakBin * sampleRate / cachedFftSize;
  const ratio = harmonicIntegerRatio(directFreq, hpsFreq);
  const fundamentalSupport = directMag > 0 ? magnitude[peakBin] / directMag : 0;

  // HPS can intentionally create f/2 or f/3 candidates for nearly pure sine
  // waves because their only strong spectral line appears as a higher harmonic
  // of a lower candidate. Guitar/violin spectra normally contain real energy
  // at the HPS fundamental. If that bin is essentially absent, use the direct
  // spectral peak instead. This preserves the original HPS behavior on rich
  // instruments while making the detector universal for flute/sine-like tones.
  if (ratio && fundamentalSupport < 0.012) {
    chosenBin = directBin;
    mode = 'direct';
  }

  let delta = 0;
  if (chosenBin > minBin && chosenBin < maxDirectBin) {
    if (mode === 'hps') {
      delta = parabolicDelta(hpsScore(chosenBin - 1), hpsScore(chosenBin), hpsScore(chosenBin + 1));
    } else {
      delta = parabolicDelta(logMag(chosenBin - 1), logMag(chosenBin), logMag(chosenBin + 1));
    }
  }

  const frequency = (chosenBin + delta) * sampleRate / cachedFftSize;
  if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) return null;

  const prominence = Number.isFinite(secondScore) ? Math.max(0, peakScore - secondScore) : 0;
  const support = mode === 'direct' ? 0.55 : Math.min(1, fundamentalSupport * 4 + 0.35);
  const clarity = clamp(0.52 + Math.min(0.30, prominence * 0.045) + support * 0.16, 0, 0.99);

  return { frequency, clarity, source: mode, hpsFrequency: hpsFreq, directFrequency: directFreq };
}

self.onmessage = (event) => {
  const data = event.data || {};
  try {
    const samples = new Float32Array(data.samples);
    const result = detect(samples, data.sampleRate, data.minFreq, data.maxFreq);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
