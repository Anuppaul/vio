(function(root, factory){
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TunerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const ASCII_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const VIOLIN_MIDI = [55, 62, 69, 76]; // G3 D4 A4 E5

  function midiFrequency(midi, a4=440){
    return a4 * Math.pow(2, (midi - 69) / 12);
  }

  function frequencyToMidi(frequency, a4=440){
    return 69 + 12 * Math.log2(frequency / a4);
  }

  function centsBetween(frequency, targetFrequency){
    return 1200 * Math.log2(frequency / targetFrequency);
  }

  function noteName(midi){
    const n = Math.round(midi);
    return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
  }

  function asciiNoteName(midi){
    const n = Math.round(midi);
    return `${ASCII_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
  }

  function parabolicPeak(values, index){
    if (index <= 0 || index >= values.length - 1) return index;
    const y0 = values[index - 1], y1 = values[index], y2 = values[index + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) < 1e-12) return index;
    const shift = 0.5 * (y0 - y2) / denom;
    return index + Math.max(-1, Math.min(1, shift));
  }

  /**
   * McLeod Pitch Method style NSDF detector.
   * Tuned for bowed/plucked violin: 150–1500 Hz.
   * Returns {frequency, clarity, rms} or null.
   */
  function detectPitch(buffer, sampleRate, options={}){
    const minFreq = options.minFreq || 150;
    const maxFreq = options.maxFreq || 1500;
    const rmsFloor = options.rmsFloor || 0.006;
    const clarityFloor = options.clarityFloor || 0.72;
    const peakRatio = options.peakRatio || 0.88;
    const n = buffer.length;
    if (!n || !sampleRate) return null;

    let mean = 0;
    for (let i=0; i<n; i++) mean += buffer[i];
    mean /= n;

    let rms = 0;
    const centered = new Float32Array(n);
    for (let i=0; i<n; i++){
      const v = buffer[i] - mean;
      centered[i] = v;
      rms += v * v;
    }
    rms = Math.sqrt(rms / n);
    if (!Number.isFinite(rms) || rms < rmsFloor) return null;

    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxLag = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2) - 2);
    if (maxLag <= minLag + 2) return null;

    const nsdf = new Float32Array(maxLag + 1);
    nsdf[0] = 1;

    for (let lag=minLag; lag<=maxLag; lag++){
      let ac = 0, energy = 0;
      const count = n - lag;
      for (let i=0; i<count; i++){
        const a = centered[i], b = centered[i + lag];
        ac += a * b;
        energy += a * a + b * b;
      }
      nsdf[lag] = energy > 1e-12 ? (2 * ac / energy) : 0;
    }

    // Collect positive local maxima. We intentionally keep early peaks because
    // harmonic-dominant violin signals may initially lock to 2x/3x; the open-string
    // matcher below corrects those harmonics reliably.
    const peaks = [];
    for (let i=minLag + 1; i<maxLag; i++){
      const v = nsdf[i];
      if (v > 0 && v >= nsdf[i-1] && v > nsdf[i+1]) peaks.push(i);
    }
    if (!peaks.length) return null;

    let bestValue = -Infinity;
    for (const p of peaks) bestValue = Math.max(bestValue, nsdf[p]);
    if (bestValue < clarityFloor) return null;

    const cutoff = Math.max(clarityFloor, bestValue * peakRatio);
    let selected = null;
    for (const p of peaks){
      if (nsdf[p] >= cutoff){ selected = p; break; }
    }
    if (selected == null) selected = peaks.reduce((a,b)=>nsdf[a] >= nsdf[b] ? a : b);

    const refinedLag = parabolicPeak(nsdf, selected);
    const frequency = sampleRate / refinedLag;
    if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) return null;

    return { frequency, clarity: nsdf[selected], rms };
  }

  /**
   * Matches a detected spectral/autocorrelation pitch to a violin open string,
   * considering harmonics 1..4. This fixes the common bowed-string problem where
   * the 2nd harmonic is stronger than the fundamental.
   */
  function matchViolinString(rawFrequency, a4=440, maxCents=70){
    if (!(rawFrequency > 0)) return null;
    let best = null;
    for (const midi of VIOLIN_MIDI){
      const target = midiFrequency(midi, a4);
      for (let harmonic=1; harmonic<=4; harmonic++){
        const harmonicTarget = target * harmonic;
        const cents = centsBetween(rawFrequency, harmonicTarget);
        const abs = Math.abs(cents);
        if (!best || abs < best.absCents){
          best = {
            midi,
            note: noteName(midi),
            ascii: asciiNoteName(midi),
            targetFrequency: target,
            harmonic,
            correctedFrequency: rawFrequency / harmonic,
            cents,
            absCents: abs
          };
        }
      }
    }
    return best && best.absCents <= maxCents ? best : null;
  }

  function nearestChromatic(rawFrequency, a4=440){
    if (!(rawFrequency > 0)) return null;
    const midiFloat = frequencyToMidi(rawFrequency, a4);
    const midi = Math.round(midiFloat);
    const targetFrequency = midiFrequency(midi, a4);
    const cents = centsBetween(rawFrequency, targetFrequency);
    return {
      midi,
      note: noteName(midi),
      ascii: asciiNoteName(midi),
      targetFrequency,
      correctedFrequency: rawFrequency,
      cents,
      absCents: Math.abs(cents),
      harmonic: 1
    };
  }

  function median(values){
    if (!values.length) return 0;
    const a = values.slice().sort((x,y)=>x-y);
    const m = Math.floor(a.length/2);
    return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
  }

  return {
    NOTE_NAMES,
    ASCII_NAMES,
    VIOLIN_MIDI,
    midiFrequency,
    frequencyToMidi,
    centsBetween,
    noteName,
    asciiNoteName,
    detectPitch,
    matchViolinString,
    nearestChromatic,
    median
  };
});
