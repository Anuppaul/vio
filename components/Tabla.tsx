'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { TAALS, type Taal } from '@/lib/tabla-taals';
import type { MixerChannel } from '@/lib/mixer-channel';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';
import type { BaithakAudio } from '@/lib/baithak-audio';
import { loadTablaSamples, type Stroke } from '@/lib/tabla-samples';

const TABLA_MAX_GAIN = 3.3;
const TABLA_PEAK_CURVE = Float32Array.from({ length: 1025 }, (_, index) => {
  const sample = index / 512 - 1;
  const magnitude = Math.abs(sample);
  if (magnitude <= .7) return sample;
  return Math.sign(sample) * (.7 + .2 * Math.tanh((magnitude - .7) / .2));
});

// Compound bols are voiced as evenly spaced Naad strokes inside one beat.
const BOL_STROKES: Record<string, readonly Stroke[]> = {
  '-': [],
  Dha: ['Dha'], Dhin: ['Dhin'], Dhi: ['Dhin'], Ga: ['Ga'], Ge: ['Ge'], Gi: ['Ge'],
  Ka: ['Ke'], Kat: ['Ke'], Ke: ['Ke'], Na: ['Na'], Ta: ['Ta'], Ti: ['Ti'],
  Tin: ['Tin'], Tu: ['Tun'],
  DhaGe: ['Dha', 'Ge'], Dhage: ['Dha', 'Ge'], DhiNa: ['Dhin', 'Na'],
  NaKe: ['Na', 'Ke'], NaTi: ['Na', 'Ti'], Gadi: ['Ga', 'Dhin'], Gana: ['Ga', 'Na'],
  Kata: ['Ke', 'Ta'], Kita: ['Ke', 'Ta'], Tina: ['Ti', 'Na'],
  Tira: ['Ti', 'Ta'], Tirakita: ['Ti', 'Ta', 'Ke', 'Ta'],
  Tita: ['Ti', 'Ta'], Traka: ['Ta', 'Ti', 'Ke', 'Ta'],
};

function rhythm(taal: Taal) {
  return TAALS[taal].beats.split(' | ').flatMap((group, division) =>
    group.split(' ').map((bol, index) => ({
      bol,
      strokes: BOL_STROKES[bol],
      divisionStart: division > 0 && index === 0,
    })),
  );
}

const TAAL_OPTIONS = Object.entries(TAALS).map(([id, item]) => ({
  id, label: `${item.name} — ${rhythm(id as Taal).length} beats`,
}));

const LAYAS = [
  { rate: .5, label: 'Aadh', mark: '½×' },
  { rate: 1, label: 'Thah', mark: '1×' },
  { rate: 2, label: 'Dugun', mark: '2×' },
  { rate: 3, label: 'Tigun', mark: '3×' },
  { rate: 4, label: 'Chaugun', mark: '4×' },
];

function formatRemaining(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type Playback = {
  context: AudioContext;
  abort: AbortController;
  gain?: GainNode;
  limiter?: DynamicsCompressorNode;
  peakGuard?: WaveShaperNode;
  sources: Set<AudioBufferSourceNode>;
  ownsContext: boolean;
  timer?: ReturnType<typeof setInterval>;
};

export default function Tabla({ note, semitones, cents = 0, channel, mixAudio, onPlaybackEnd }: {
  note: string; semitones: number; cents?: number; channel?: Ref<MixerChannel>; mixAudio?: BaithakAudio;
  onPlaybackEnd?: () => void;
}) {
  const [taal, setTaal] = useState<Taal>('teentaal');
  const [bpm, setBpm] = useState(channel ? 33 : 80);
  const [layakari, setLayakari] = useState(1);
  const [delayMinutes, setDelayMinutes] = useState('0');
  const [delayRemaining, setDelayRemaining] = useState<number | null>(null);
  const [practiceEnabled, setPracticeEnabled] = useState(false);
  const [practiceMinutes, setPracticeMinutes] = useState(LAYAS.map(() => '6'));
  const [practice, setPractice] = useState<{ stage: number; stageRemaining: number; totalRemaining: number } | null>(null);
  const [volume, setVolume] = useState(channel ? 38 : 65);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'complete' | 'invalid-duration' | 'invalid-delay' | 'error'>('idle');
  const [activeBeat, setActiveBeat] = useState(-1);
  const playback = useRef<Playback | null>(null);
  const settings = useRef({ taal, bpm, layakari, volume, semitones, cents });
  const totalMinutes = practiceMinutes.reduce((sum, value) => sum + Number(value), 0);

  useEffect(() => {
    settings.current = { taal, bpm, layakari, volume, semitones, cents };
    const session = playback.current;
    session?.gain?.gain.setTargetAtTime(volume / 100 * TABLA_MAX_GAIN, session.context.currentTime, .02);
  }, [taal, bpm, layakari, volume, semitones, cents]);

  function release() {
    const session = playback.current;
    playback.current = null;
    if (!session) return;
    session.abort.abort();
    clearInterval(session.timer);
    for (const source of session.sources) source.stop();
    session.gain?.disconnect();
    session.limiter?.disconnect();
    session.peakGuard?.disconnect();
    if (session.ownsContext) void session.context.close().catch(() => {});
  }

  function stop() {
    release();
    setActiveBeat(-1);
    setPractice(null);
    setDelayRemaining(null);
    setStatus('idle');
  }

  useEffect(() => {
    if (mixAudio) return release;
    function onVisibilityChange() {
      if (document.hidden && playback.current) stop();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    };
  }, []);

  async function play() {
    if (playback.current) return;
    const delaySeconds = Number(delayMinutes) * 60;
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
      setStatus('invalid-delay');
      onPlaybackEnd?.();
      return;
    }
    let durationSeconds = 0;
    const plan: { stage: number; end: number }[] = [];
    if (practiceEnabled) {
      const durations = practiceMinutes.map(value => Number(value) * 60);
      if (!Number.isFinite(totalMinutes * 60) || totalMinutes <= 0 ||
          durations.some(seconds => seconds !== 0 && seconds < 6)) {
        setStatus('invalid-duration');
        onPlaybackEnd?.();
        return;
      }
      for (const [stage, seconds] of durations.entries()) {
        if (!seconds) continue;
        durationSeconds += seconds;
        plan.push({ stage, end: durationSeconds });
      }
    }
    const mix = mixAudio?.get();
    const context = mixAudio ? mix?.context : createBrowserAudioContext();
    if (!context) {
      setStatus('error');
      onPlaybackEnd?.();
      return;
    }

    const session: Playback = { context, abort: new AbortController(), sources: new Set(), ownsContext: !mix };
    playback.current = session;
    setStatus('loading');

    try {
      await resumeBrowserAudio(context);
      if (playback.current !== session) return;
      if (context.state !== 'running') throw new Error('Audio context unavailable');
      const delayEndAt = context.currentTime + delaySeconds;
      const nextTake = await loadTablaSamples(context, session.abort.signal);
      if (playback.current !== session) return;

      const gain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const peakGuard = context.createWaveShaper();
      session.gain = gain;
      session.limiter = limiter;
      session.peakGuard = peakGuard;
      gain.gain.value = settings.current.volume / 100 * TABLA_MAX_GAIN;
      // Fast bols can overlap. Leave headroom for the rest of the Taalmala mix.
      limiter.threshold.value = -4;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = .001;
      limiter.release.value = .06;
      // Round off transients that slip through the compressor on dense bols.
      peakGuard.curve = TABLA_PEAK_CURVE;
      gain.connect(limiter).connect(peakGuard).connect(mix?.output ?? context.destination);

      let selectedTaal = settings.current.taal;
      let beats = rhythm(selectedTaal);
      let index = 0;
      const startAt = Math.max(context.currentTime, delayEndAt) + .04;
      const endAt = durationSeconds ? startAt + durationSeconds : Infinity;
      let nextBeat = startAt;
      let lastDelayRemaining: number | null = null;
      let lastStage = -1;
      let lastStageRemaining = -1;
      let lastRemaining = -1;
      let pending: { index: number; time: number }[] = [];

      function practiceStep(at: number) {
        return plan.find(step => at < startAt + step.end) ?? plan[plan.length - 1];
      }

      function schedule() {
        if (playback.current !== session) return;
        const now = session.context.currentTime;
        if (now < delayEndAt) {
          const remaining = Math.ceil(delayEndAt - now);
          if (remaining !== lastDelayRemaining) {
            lastDelayRemaining = remaining;
            setDelayRemaining(remaining);
          }
          return;
        }
        if (lastDelayRemaining !== null) {
          lastDelayRemaining = null;
          setDelayRemaining(null);
        }
        if (now >= endAt) {
          stop();
          setStatus('complete');
          onPlaybackEnd?.();
          return;
        }
        if (durationSeconds) {
          const { stage, end } = practiceStep(now);
          const elapsed = Math.max(0, now - startAt);
          const stageRemaining = Math.ceil(end - elapsed);
          const remaining = Math.ceil(durationSeconds - elapsed);
          if (stage !== lastStage || stageRemaining !== lastStageRemaining || remaining !== lastRemaining) {
            setPractice({ stage, stageRemaining, totalRemaining: remaining });
            lastStage = stage;
            lastStageRemaining = stageRemaining;
            lastRemaining = remaining;
          }
        }
        const current = settings.current;
        if (current.taal !== selectedTaal) {
          selectedTaal = current.taal;
          beats = rhythm(selectedTaal);
          pending = [];
          index = 0;
          setActiveBeat(-1);
        }
        while (pending.length && pending[0].time <= now) {
          setActiveBeat(pending.shift()!.index);
        }

        // Recover from a delayed timer without playing missed beats all at once.
        if (nextBeat < now) nextBeat = now + .015;
        // Na and Tin in the Naad set have a sustained partial near C5.
        const rate = 2 ** ((current.semitones > 6 ? current.semitones - 12 : current.semitones) / 12);
        while (nextBeat < Math.min(now + .09, endAt)) {
          const laya = durationSeconds ? LAYAS[practiceStep(nextBeat).stage].rate : current.layakari;
          const duration = 60 / (current.bpm * laya);
          const beat = beats[index];
          for (const [part, stroke] of beat.strokes.entries()) {
            const at = nextBeat + part * duration / beat.strokes.length;
            if (at >= endAt) break;
            const take = nextTake(stroke);
            const source = session.context.createBufferSource();
            source.buffer = take.buffer;
            source.detune.value = current.cents;
            source.playbackRate.value = rate * take.rate;
            source.connect(gain);
            session.sources.add(source);
            source.onended = () => {
              session.sources.delete(source);
              source.disconnect();
            };
            source.start(at);
          }
          pending.push({ index, time: nextBeat });
          index = (index + 1) % beats.length;
          nextBeat += duration;
        }
      }

      schedule();
      session.timer = setInterval(schedule, 20);
      setStatus('playing');
    } catch {
      if (playback.current !== session) return;
      release();
      setStatus('error');
      onPlaybackEnd?.();
    }
  }

  useImperativeHandle(channel, () => ({ start: play, stop }));

  const playing = status === 'playing';
  const busy = status === 'loading' || playing;
  const beats = rhythm(taal);
  const effectiveBpm = practice ? bpm * LAYAS[practice.stage].rate : bpm;
  const firstPracticeLaya = LAYAS.find((_, index) => Number(practiceMinutes[index]) > 0)?.rate ?? LAYAS[0].rate;

  const cycle = beats.reduce<number[]>((groups, beat) => {
    if (!groups.length || beat.divisionStart) groups.push(1);
    else groups[groups.length - 1]++;
    return groups;
  }, []);
  const theka = (
    <ol className="tabla-beats" aria-label="Theka">
      {beats.map((beat, index) => (
        <li key={index} data-bol aria-current={index === activeBeat ? 'step' : undefined}
          className={beat.divisionStart ? 'tabla-division' : undefined}>
          <small>{index + 1}</small>{!channel && <span>{beat.bol}</span>}
        </li>
      ))}
    </ol>
  );
  return (
    <section className="card tabla-card" aria-labelledby="tabla-heading">
      <div className="card-head">
        <h2 id="tabla-heading">Tabla</h2>
        <span>Sa · {note}</span>
      </div>
      <div className="section tabla-controls">
        <label className="control">
          <span className="control-label" id="tabla-taal-label">Taal</span>
          <select aria-labelledby="tabla-taal-label" value={taal} onChange={event => setTaal(event.target.value as Taal)}>
            {TAAL_OPTIONS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="control">
          <span className="control-label" id="tabla-layakari-label">{channel ? 'Laya' : 'Layakari'}</span>
          <select aria-labelledby="tabla-layakari-label" disabled={practiceEnabled}
            value={practice ? LAYAS[practice.stage].rate : practiceEnabled ? firstPracticeLaya : layakari}
            onChange={event => setLayakari(Number(event.target.value))}>
            {LAYAS.map(({ rate, label, mark }) => <option key={rate} value={rate}>{label} · {mark}</option>)}
          </select>
        </label>
        {channel && <div className="baithak-cycle">
          <div><span>Cycle</span><span>{cycle.join(' · ')}</span></div>
          {theka}
          <strong>{beats[Math.max(0, activeBeat)]?.bol}</strong>
        </div>}
        <label className="control baithak-wide">
          <span className="control-label"><span>Tempo</span><span>{bpm} BPM</span></span>
          <input className="range" type="range" min="20" max="240" value={bpm} onChange={event => setBpm(Number(event.target.value))} />
        </label>
        <label className="control baithak-wide">
          <span className="control-label"><span>Tabla volume</span><span>{volume}%</span></span>
          <input className="range" type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} />
        </label>
        <label className="control baithak-wide tabla-delay">
          <span className="control-label">Start delay (min)</span>
          <input type="number" min="0" step="any" value={delayMinutes} disabled={busy}
            onChange={event => {
              setDelayMinutes(event.target.value);
              if (status === 'complete' || status === 'invalid-delay') setStatus('idle');
            }} />
        </label>
        <label className="tabla-practice-toggle">
          <input type="checkbox" checked={practiceEnabled} disabled={busy}
            onChange={event => {
              setPracticeEnabled(event.target.checked);
              if (status === 'complete' || status === 'invalid-duration') setStatus('idle');
            }} /> Timed practice
        </label>
        {practiceEnabled && <fieldset className="tabla-practice" disabled={busy}>
          <legend>Minutes per laya</legend>
          <div className="tabla-practice-stages">
            {LAYAS.map(({ rate, mark }, index) => <label key={rate} aria-current={practice?.stage === index ? 'step' : undefined}>
              <span>{mark}</span>
              <input type="number" aria-label={`${mark} minutes`} min="0" step="any" value={practiceMinutes[index]}
                onChange={event => {
                  const value = event.target.value;
                  setPracticeMinutes(previous => previous.map((minutes, i) => i === index ? value : minutes));
                  if (status === 'complete' || status === 'invalid-duration') setStatus('idle');
                }} />
            </label>)}
          </div>
          <small>Total {Number.isFinite(totalMinutes) ? Number(totalMinutes.toFixed(2)) : '–'} min · 0 skips a laya</small>
        </fieldset>}
        {delayRemaining !== null && <div className="tabla-status tabla-practice-readout" aria-live="off">
          <strong>Tabla starts in {formatRemaining(delayRemaining)}</strong>
        </div>}
        {practice && <div className="tabla-status tabla-practice-readout" aria-live="off">
          <strong>Now playing {LAYAS[practice.stage].mark} · {effectiveBpm} BPM</strong>
          <span>Laya {formatRemaining(practice.stageRemaining)} left</span>
          <span>Total {formatRemaining(practice.totalRemaining)} left</span>
        </div>}
        {status === 'complete' && <p className="tabla-status" role="status">Practice complete</p>}
        {status === 'invalid-duration' && <p className="tabla-status" role="alert">Set at least one laya to 0.1 minutes or more. Use 0 to skip a laya.</p>}
        {status === 'invalid-delay' && <p className="tabla-status" role="alert">Enter a start delay of 0 minutes or more.</p>}
        {!channel && theka}
        {status === 'error' && <p className="tabla-status" role="alert">Tabla audio could not load. Try again.</p>}
        {!channel && <button className={`primary ${busy ? 'danger' : ''}`} onClick={busy ? stop : () => void play()}>
          {delayRemaining !== null ? 'Cancel Start' : playing ? 'Stop Tabla' : busy ? 'Cancel Loading' : 'Play Tabla'}
        </button>}
      </div>
    </section>
  );
}
