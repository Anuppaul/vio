export type PitchMode = 'sustained' | 'transient';

export type PitchCandidate = {
  frequency: number;
  clarity: number;
  mode: PitchMode;
};

export type PitchObservation = PitchCandidate & {
  rms: number;
  now: number;
};

export type PitchTrackResult = {
  frequency: number | null;
  confidence: number;
  held: boolean;
  state: 'idle' | 'candidate' | 'locked' | 'transition' | 'dropout';
};

const MIN_RMS = 1e-6;
const LOCK_TOLERANCE_CENTS = 70;
const SWITCH_TOLERANCE_CENTS = 45;
const DROPOUT_HOLD_MS = 150;
const RELEASE_MS = 240;

export function centsApart(a: number, b: number) {
  if (!(a > 0) || !(b > 0)) return Infinity;
  return Math.abs(1200 * Math.log2(a / b));
}

function medianLog(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.map(Math.log2).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.pow(2, value);
}

function pushCluster(values: number[], frequency: number, tolerance: number, max: number) {
  if (values.length && centsApart(medianLog(values), frequency) > tolerance) values.length = 0;
  values.push(frequency);
  while (values.length > max) values.shift();
}

function dbToAmplitude(db: number) {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

function spectrumAmplitude(
  spectrum: Float32Array,
  frequency: number,
  sampleRate: number
) {
  if (!(frequency > 0) || !spectrum.length || !(sampleRate > 0)) return 0;
  const fftSize = spectrum.length * 2;
  const exactBin = frequency * fftSize / sampleRate;
  const center = Math.round(exactBin);
  let best = 0;
  for (let offset = -1; offset <= 1; offset++) {
    const index = center + offset;
    if (index < 0 || index >= spectrum.length) continue;
    best = Math.max(best, dbToAmplitude(spectrum[index]));
  }
  return best;
}

export function harmonicSupport(
  frequency: number,
  spectrum: Float32Array,
  sampleRate: number,
  harmonics = 8
) {
  if (!(frequency > 0)) return 0;
  const nyquist = sampleRate / 2;
  let weighted = 0;
  let totalWeight = 0;
  for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
    const target = frequency * harmonic;
    if (target >= nyquist) break;
    const weight = 1 / Math.sqrt(harmonic);
    weighted += spectrumAmplitude(spectrum, target, sampleRate) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0;
}

type ScoredCandidate = PitchCandidate & {
  support: number;
  transformPenalty: number;
  evidence: number;
};

function addCandidate(
  output: ScoredCandidate[],
  frequency: number,
  clarity: number,
  mode: PitchMode,
  transformPenalty: number,
  spectrum: Float32Array,
  sampleRate: number,
  minFrequency: number,
  maxFrequency: number,
  evidence: number
) {
  if (!(frequency >= minFrequency && frequency <= maxFrequency)) return;
  const existing = output.find(candidate => centsApart(candidate.frequency, frequency) <= 10);
  const support = harmonicSupport(frequency, spectrum, sampleRate);
  if (existing) {
    if (clarity > existing.clarity) {
      existing.clarity = clarity;
      existing.mode = mode;
      existing.transformPenalty = Math.min(existing.transformPenalty, transformPenalty);
    }
    existing.support = Math.max(existing.support, support);
    existing.evidence = Math.min(3, existing.evidence + evidence);
    return;
  }
  output.push({ frequency, clarity, mode, support, transformPenalty, evidence });
}

/**
 * Fuse long/short time-domain estimates with cheap spectral harmonic evidence.
 * The transformed candidates let a strong 2x/3x harmonic or a 1/2 subharmonic
 * compete with the raw detector result without blindly forcing an octave.
 */
export function chooseHarmonicCandidate(
  long: PitchCandidate,
  short: PitchCandidate,
  consensus: PitchCandidate | PitchCandidate[] | null,
  spectrum: Float32Array,
  sampleRate: number,
  minFrequency: number,
  maxFrequency: number
): PitchCandidate {
  const candidates: ScoredCandidate[] = [];
  const sources: Array<{candidate:PitchCandidate;weight:number}> = [
    {candidate:long,weight:1},
    {candidate:short,weight:.86}
  ];
  if(consensus){
    const independent = Array.isArray(consensus) ? consensus : [consensus];
    independent.forEach((candidate,index)=>{
      sources.push({candidate,weight:index===0?1.25:1.18});
    });
  }

  for (const {candidate:source,weight} of sources) {
    if (!(source.frequency >= minFrequency && source.frequency <= maxFrequency)) continue;
    addCandidate(candidates, source.frequency, source.clarity, source.mode, 0, spectrum, sampleRate, minFrequency, maxFrequency, weight);
    addCandidate(candidates, source.frequency / 2, source.clarity, source.mode, 0.04, spectrum, sampleRate, minFrequency, maxFrequency, weight*.32);
    addCandidate(candidates, source.frequency / 3, source.clarity, source.mode, 0.075, spectrum, sampleRate, minFrequency, maxFrequency, weight*.24);
    addCandidate(candidates, source.frequency * 2, source.clarity, source.mode, 0.06, spectrum, sampleRate, minFrequency, maxFrequency, weight*.28);
  }

  if (!candidates.length) return { frequency: 0, clarity: 0, mode: long.mode };
  const maxSupport = Math.max(...candidates.map(candidate => candidate.support), 1e-12);
  const maxEvidence = Math.max(...candidates.map(candidate => candidate.evidence), 1e-12);
  candidates.sort((a, b) => {
    const scoreA =
      a.clarity * .52 +
      (a.support / maxSupport) * .30 +
      (a.evidence / maxEvidence) * .18 -
      a.transformPenalty;
    const scoreB =
      b.clarity * .52 +
      (b.support / maxSupport) * .30 +
      (b.evidence / maxEvidence) * .18 -
      b.transformPenalty;
    return scoreB - scoreA;
  });
  const best = candidates[0];
  const agreementBoost = Math.min(.12, Math.max(0,best.evidence-1)*.08);
  return {
    frequency: best.frequency,
    clarity: Math.min(1,best.clarity+agreementBoost),
    mode: best.mode
  };
}

function harmonicNear(reference: number, frequency: number) {
  if (!(reference > 0) || !(frequency > 0)) return false;
  for (const factor of [0.25, 1 / 3, 0.5, 2, 3, 4]) {
    if (centsApart(reference, frequency * factor) <= 38) return true;
  }
  return false;
}

export class PitchTracker {
  private noiseFloor = 0;
  private locked = 0;
  private lastGood = 0;
  private initialHistory: number[] = [];
  private lockHistory: number[] = [];
  private switchHistory: number[] = [];

  reset() {
    this.noiseFloor = 0;
    this.locked = 0;
    this.lastGood = 0;
    this.initialHistory.length = 0;
    this.lockHistory.length = 0;
    this.switchHistory.length = 0;
  }

  private holdOrRelease(now: number, state: PitchTrackResult['state'] = 'dropout'): PitchTrackResult {
    if (this.locked > 0 && now - this.lastGood <= DROPOUT_HOLD_MS) {
      return { frequency: this.locked, confidence: 0, held: true, state };
    }
    if (this.locked > 0 && now - this.lastGood > RELEASE_MS) {
      this.locked = 0;
      this.initialHistory.length = 0;
      this.lockHistory.length = 0;
      this.switchHistory.length = 0;
    }
    return { frequency: null, confidence: 0, held: false, state: 'idle' };
  }

  accept(observation: PitchObservation): PitchTrackResult {
    const { frequency, clarity, rms, mode, now } = observation;
    const minimumClarity = mode === 'transient' ? 0.58 : 0.66;

    if (this.noiseFloor <= 0 && rms > 0) this.noiseFloor = Math.max(MIN_RMS, rms * 0.18);
    const floor = Math.max(this.noiseFloor, MIN_RMS);
    const snrRatio = rms > 0 ? rms / floor : 0;
    const strongPeriodic = clarity >= 0.9;
    const voiced = frequency > 0 && rms >= MIN_RMS && clarity >= minimumClarity && (snrRatio >= 1.18 || strongPeriodic);

    if (!voiced) {
      if (rms > 0 && rms <= floor * 1.8) {
        this.noiseFloor = floor * 0.985 + rms * 0.015;
      }
      return this.holdOrRelease(now);
    }

    if (rms <= floor * 1.45 && clarity < 0.82) {
      this.noiseFloor = floor * 0.992 + rms * 0.008;
    }

    const snrConfidence = Math.max(0, Math.min(1, (snrRatio - 1) / 2.5));
    const confidence = Math.max(0, Math.min(1, clarity * 0.72 + snrConfidence * 0.28));

    if (!(this.locked > 0)) {
      pushCluster(this.initialHistory, frequency, SWITCH_TOLERANCE_CENTS, 4);
      const needed = mode === 'transient' ? 2 : 2;
      if (this.initialHistory.length < needed) {
        return { frequency: null, confidence, held: false, state: 'candidate' };
      }
      this.locked = medianLog(this.initialHistory);
      this.lastGood = now;
      this.lockHistory = [this.locked];
      this.initialHistory.length = 0;
      return { frequency: this.locked, confidence, held: false, state: 'locked' };
    }

    const distance = centsApart(this.locked, frequency);
    if (distance <= LOCK_TOLERANCE_CENTS) {
      pushCluster(this.lockHistory, frequency, LOCK_TOLERANCE_CENTS, 6);
      const center = medianLog(this.lockHistory);
      const alpha = mode === 'transient' ? 0.5 : 0.34;
      this.locked = Math.pow(
        2,
        Math.log2(this.locked) * (1 - alpha) + Math.log2(center) * alpha
      );
      this.lastGood = now;
      this.switchHistory.length = 0;
      return { frequency: this.locked, confidence, held: false, state: 'locked' };
    }

    pushCluster(this.switchHistory, frequency, SWITCH_TOLERANCE_CENTS, 5);
    const harmonicConflict = harmonicNear(this.locked, frequency);
    const requiredFrames = harmonicConflict ? (confidence >= 0.94 ? 3 : 4) : 2;

    if (this.switchHistory.length >= requiredFrames) {
      this.locked = medianLog(this.switchHistory);
      this.lastGood = now;
      this.lockHistory = [this.locked];
      this.switchHistory.length = 0;
      return { frequency: this.locked, confidence, held: false, state: 'locked' };
    }

    return {
      frequency: this.locked,
      confidence,
      held: true,
      state: 'transition'
    };
  }
}

function smoothingAlpha(cutoff: number, dtSeconds: number) {
  if (!(cutoff > 0) || !(dtSeconds > 0)) return 1;
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSeconds);
}

export class OneEuroFilter {
  private initialized = false;
  private previousValue = 0;
  private previousDerivative = 0;
  private previousTime = 0;

  constructor(
    private readonly minCutoff = 1.35,
    private readonly beta = 0.055,
    private readonly derivativeCutoff = 1.0
  ) {}

  reset() {
    this.initialized = false;
    this.previousValue = 0;
    this.previousDerivative = 0;
    this.previousTime = 0;
  }

  filter(value: number, nowMs: number) {
    if (!this.initialized) {
      this.initialized = true;
      this.previousValue = value;
      this.previousDerivative = 0;
      this.previousTime = nowMs;
      return value;
    }

    const dt = Math.max(0.001, Math.min(0.25, (nowMs - this.previousTime) / 1000));
    const derivative = (value - this.previousValue) / dt;
    const derivativeAlpha = smoothingAlpha(this.derivativeCutoff, dt);
    const filteredDerivative =
      derivativeAlpha * derivative + (1 - derivativeAlpha) * this.previousDerivative;
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const valueAlpha = smoothingAlpha(cutoff, dt);
    const filteredValue = valueAlpha * value + (1 - valueAlpha) * this.previousValue;

    this.previousValue = filteredValue;
    this.previousDerivative = filteredDerivative;
    this.previousTime = nowMs;
    return filteredValue;
  }
}
