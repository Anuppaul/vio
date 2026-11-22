'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { TAALS, type Taal } from '@/lib/tabla-taals';
import type { MixerChannel } from '@/lib/mixer-channel';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';
import type { BaithakAudio } from '@/lib/baithak-audio';

const STROKES = ['Dha', 'Dhin', 'Ga', 'Ge', 'Ke', 'Na', 'Ta', 'Ti', 'Tin', 'Tun'] as const;
type Stroke = typeof STROKES[number];

// Naad's first Tun take has a dominant partial near 285 Hz (C4 target).
const TUN_PITCH_CORRECTION = 261.626 / 285;

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

export type TablaReadout = { name: string; bpm: number; beat: number; total: number };

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

type Playback = {
  context: AudioContext;
  abort: AbortController;
  gain?: GainNode;
  sources: Set<AudioBufferSourceNode>;
  ownsContext: boolean;
  timer?: ReturnType<typeof setInterval>;
};

export default function Tabla({ note, semitones, cents = 0, channel, mixAudio, onReadout }: {
  note: string; semitones: number; cents?: number; channel?: Ref<MixerChannel>; mixAudio?: BaithakAudio;
  onReadout?: (readout: TablaReadout) => void;
}) {
  const [taal, setTaal] = useState<Taal>('teentaal');
  const [bpm, setBpm] = useState(channel ? 33 : 80);
  const [layakari, setLayakari] = useState(1);
  const [volume, setVolume] = useState(channel ? 38 : 65);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [activeBeat, setActiveBeat] = useState(-1);
  const playback = useRef<Playback | null>(null);
  const settings = useRef({ taal, bpm, layakari, volume, semitones, cents });

  useEffect(() => {
    settings.current = { taal, bpm, layakari, volume, semitones, cents };
    const session = playback.current;
    session?.gain?.gain.setTargetAtTime(volume * .0035, session.context.currentTime, .02);
  }, [taal, bpm, layakari, volume, semitones, cents]);

  function release() {
    const session = playback.current;
    playback.current = null;
    if (!session) return;
    session.abort.abort();
    clearInterval(session.timer);
    for (const source of session.sources) source.stop();
    session.gain?.disconnect();
    if (session.ownsContext) void session.context.close().catch(() => {});
  }

  function stop() {
    release();
    setActiveBeat(-1);
    setStatus('idle');
  }

  useEffect(() => {
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
    const mix = mixAudio?.get();
    const context = mixAudio ? mix?.context : createBrowserAudioContext();
    if (!context) {
      setStatus('error');
      return;
    }

    const session: Playback = { context, abort: new AbortController(), sources: new Set(), ownsContext: !mix };
    playback.current = session;
    setStatus('loading');

    try {
      await resumeBrowserAudio(context);
      if (playback.current !== session) return;
      if (context.state !== 'running') throw new Error('Audio context unavailable');
      const buffers = new Map(await Promise.all(STROKES.map(async stroke => {
        const response = await fetch(`/assets/tabla/${stroke}.wav`, { signal: session.abort.signal });
        if (!response.ok) throw new Error(`Missing tabla stroke: ${stroke}`);
        return [stroke, await context.decodeAudioData(await response.arrayBuffer())] as const;
      })));
      if (playback.current !== session) return;

      const gain = context.createGain();
      session.gain = gain;
      gain.gain.value = settings.current.volume * .0035;
      gain.connect(mix?.output ?? context.destination);

      let selectedTaal = settings.current.taal;
      let beats = rhythm(selectedTaal);
      let index = 0;
      let nextBeat = context.currentTime + .04;
      let pending: { index: number; time: number }[] = [];

      function schedule() {
        if (playback.current !== session) return;
        const now = session.context.currentTime;
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
        const duration = 60 / (current.bpm * current.layakari);
        if (nextBeat < now) nextBeat = now + .015;
        // Na and Tin in the Naad set have a sustained partial near C5.
        const rate = 2 ** ((current.semitones > 6 ? current.semitones - 12 : current.semitones) / 12);
        while (nextBeat < now + .09) {
          const beat = beats[index];
          for (const [part, stroke] of beat.strokes.entries()) {
            const source = session.context.createBufferSource();
            source.buffer = buffers.get(stroke)!;
            source.detune.value = current.cents;
            source.playbackRate.value = rate * (stroke === 'Tun' ? TUN_PITCH_CORRECTION : 1);
            source.connect(gain);
            session.sources.add(source);
            source.onended = () => {
              session.sources.delete(source);
              source.disconnect();
            };
            const at = nextBeat + part * duration / beat.strokes.length;
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
    }
  }

  useImperativeHandle(channel, () => ({ start: play, stop }));

  const playing = status === 'playing';
  const busy = status === 'loading' || playing;
  const beats = rhythm(taal);
  const total = beats.length;
  useEffect(() => {
    onReadout?.({ name: TAALS[taal].name, bpm, beat: activeBeat, total });
  }, [onReadout, taal, bpm, activeBeat, total]);

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
          <select aria-labelledby="tabla-layakari-label" value={layakari} onChange={event => setLayakari(Number(event.target.value))}>
            <option value={0.5}>Aadh · ½×</option>
            <option value={1}>Thah · 1×</option>
            <option value={2}>Dugun · 2×</option>
            <option value={3}>Tigun · 3×</option>
            <option value={4}>Chaugun · 4×</option>
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
        {!channel && theka}
        {status === 'error' && <p className="tabla-status" role="alert">Tabla audio could not load. Try again.</p>}
        {!channel && <button className={`primary ${busy ? 'danger' : ''}`} onClick={busy ? stop : () => void play()}>
          {playing ? 'Stop Tabla' : busy ? 'Cancel Loading' : 'Play Tabla'}
        </button>}
      </div>
    </section>
  );
}
