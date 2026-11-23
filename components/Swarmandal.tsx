'use client';

import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type Ref } from 'react';
import type { MixerChannel } from '@/lib/mixer-channel';
import type { BaithakAudio } from '@/lib/baithak-audio';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';
import { SA_KEYS, saFrequency } from '@/lib/riyaaz';
import { RAGA_GROUPS, renderPluck, tunedStrings, type Raga, type SwarmandalSound } from '@/lib/swarmandal';

type Direction = 'up' | 'down' | 'pakad';
type Session = { context: AudioContext; gain: GainNode; room: GainNode | null; buffers: Map<number, AudioBuffer>; sources: Set<AudioBufferSourceNode>; nextManual: number };

function createRoom(context: AudioContext, input: GainNode, amount: number) {
  const wet = context.createGain();
  const reverb = context.createConvolver();
  const length = Math.round(context.sampleRate * .6);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let seed = 1;
  for (let channel = 0; channel < 2; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let index = 0; index < length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[index] = (seed / 2147483648 - 1) * (1 - index / length) ** 3;
    }
  }
  reverb.buffer = impulse;
  wet.gain.value = amount * .65;
  input.connect(reverb).connect(wet).connect(context.destination);
  return wet;
}

type SwarmandalProps = { note: string; cents?: number } & (
  | { mode: 'mix'; channel: Ref<MixerChannel>; mixAudio: BaithakAudio; onNoteChange?: never }
  | { mode?: 'standalone'; channel?: never; mixAudio?: never; onNoteChange: (note: string) => void }
);

export default function Swarmandal({ note, cents = 0, mode = 'standalone', channel, mixAudio, onNoteChange }: SwarmandalProps) {
  const inMix = mode === 'mix';
  const [raga, setRaga] = useState<Raga>('yaman');
  const [interval, setIntervalSeconds] = useState(inMix ? '9' : '3');
  const [direction, setDirection] = useState<Direction>('down');
  const [speed, setSpeed] = useState(inMix ? 45 : 125);
  const [volume, setVolume] = useState(inMix ? 32 : 80);
  const [sound,setSound] = useState<SwarmandalSound>('acoustic');
  const [ring,setRing] = useState(4);
  const [room,setRoom] = useState(.35);
  const [repeat,setRepeat] = useState(false);
  const stringButtons = useRef(new Map<number,HTMLButtonElement>());
  const [active, setActive] = useState(false);
  const [auto, setAuto] = useState(false);
  const [sweeps, setSweeps] = useState(0);
  const [error, setError] = useState(false);
  const audio = useRef<Session | null>(null);
  const gesture = useRef<{ pointer: number; string: number } | null>(null);
  const strings = tunedStrings(saFrequency(note) * 2 ** (cents / 1200), raga);
  const seconds = inMix ? Number(interval) : Number(interval);

  function release() {
    const session = audio.current;
    audio.current = null;
    if (!session) return;
    for (const source of session.sources) source.stop();
    session.gain.disconnect();
    if (!mixAudio) void session.context.close().catch(() => {});
  }

  function stop() {
    release();
    setActive(false);
    setAuto(false);
    setSweeps(0);
  }

  useEffect(() => {
    if (mixAudio) return release;
    function onVisibility() {
      if (document.hidden) stop();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      release();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    audio.current?.buffers.clear();
  }, [note, raga, cents, sound, ring]);

  useEffect(() => {
    const session = audio.current;
    session?.gain.gain.setTargetAtTime(volume * .0024, session.context.currentTime, .025);
  }, [volume]);

  useEffect(() => {
    const session = audio.current;
    session?.room?.gain.setTargetAtTime(room * .65, session.context.currentTime, .025);
  }, [room]);

  async function play(indices: number[], sweep = false, spacing = speed) {
    let session = audio.current;
    if (!session) {
      const mix = mixAudio?.get();
      const context = mixAudio ? mix?.context : createBrowserAudioContext();
      if (!context) {
        setError(true);
        return false;
      }
      const gain = context.createGain();
      gain.gain.value = volume * .0024;
      gain.connect(mix?.output ?? context.destination);
      session = { context, gain, room: inMix ? null : createRoom(context,gain,room), buffers: new Map(), sources: new Set(), nextManual: 0 };
      audio.current = session;
    }
    const { context, gain, buffers } = session;
    await resumeBrowserAudio(context);
    if (audio.current !== session) return false;
    if (context.state !== 'running') {
      stop();
      setError(true);
      return false;
    }
    const sources = indices.map(index => {
      const {frequency} = strings[index];
      let buffer = buffers.get(frequency);
      if (!buffer) {
        buffer = inMix ? renderPluck(context, frequency) : renderPluck(context, frequency, ring, sound);
        buffers.set(frequency, buffer);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      session.sources.add(source);
      source.onended = () => {
        session.sources.delete(source);
        source.disconnect();
      };
      return source;
    });
    const step = (sweep ? spacing : 7) / 1000;
    const start = Math.max(context.currentTime + .012, sweep ? 0 : session.nextManual);
    sources.forEach((source, index) => {
      source.start(start + index * step);
      if (!inMix && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stringButtons.current.get(indices[index])?.firstElementChild?.animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(-1px)' }, { transform: 'translateX(0)' }],
          { duration: 210, delay: Math.max(0,(start-context.currentTime)*1000 + index*step*1000) },
        );
      }
    });
    if (!sweep) session.nextManual = start + sources.length * step;
    setActive(true);
    setError(false);
    if (sweep) setSweeps(value => value + 1);
    return true;
  }

  function strum(order: Direction) {
    const indices = strings.map((_, index) => index);
    if (order === 'pakad') {
      // Create a short ascent and answer it with a return to Sa in the selected tuning.
      const octave = strings.findIndex(string => string.octave === 1);
      const upper = Math.min(strings.length - 1, octave + 3);
      const phrase = indices.slice(octave, upper + 1);
      return play([...phrase, ...phrase.slice(0, -1).reverse()], true, speed * 2);
    }
    return play(order === 'down' ? indices.reverse() : indices, true);
  }

  useEffect(() => {
    if (!auto || seconds === 0 || (!inMix && !repeat)) return;
    const sweepLength = direction === 'pakad' ? speed * 14 : speed * 32;
    const period = Math.max(seconds * 1000, sweepLength);
    const timer = window.setInterval(() => {
      // The mixer resumes a shared context after an OS interruption. Do not
      // queue a new sweep every interval while its audio clock is paused.
      if (inMix && audio.current?.context.state !== 'running') return;
      void strum(direction);
    }, period);
    return () => window.clearInterval(timer);
  }, [auto, direction, note, raga, seconds, speed, volume, cents, repeat, ring, sound, room, inMix]);

  async function startAuto() {
    if (!auto && await strum(direction)) setAuto(true);
  }

  useImperativeHandle(channel, () => ({ start: startAuto, stop }));

  function moveAcrossStrings(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    const next = Math.min(strings.length - 1, Math.max(0,
      Math.floor((event.clientX - bounds.left) / bounds.width * strings.length)));
    if (next === current.string) return;
    const step = Math.sign(next - current.string);
    const crossed = Array.from({ length: Math.abs(next - current.string) }, (_, index) =>
      current.string + step * (index + 1));
    current.string = next;
    void play(crossed);
  }

  const ragaPicker = (
    <label className="control">
      <span className="control-label" id="swarmandal-raga">{inMix ? 'Raag' : 'Raga'}</span>
      <select aria-labelledby="swarmandal-raga" value={raga} onChange={event => setRaga(event.target.value as Raga)}>
        {Object.entries(RAGA_GROUPS).map(([thaat, ragas]) => (
          <optgroup key={thaat} label={thaat}>
            {ragas.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );

  const stringsPerSecond = Math.round(1000 / speed);
  const speedInput = (
    <input className="range" type="range" aria-label="Speed" min="3" max="33" step="1"
      value={stringsPerSecond} onChange={event => setSpeed(1000 / Number(event.target.value))} />
  );

  if (inMix) {
    return (
      <section className="section swarmandal-controls" aria-label="Swarmandal">
        {ragaPicker}
        <label className="control">
          <span className="control-label"><span>Sweep Every</span><output>{seconds ? `${seconds.toFixed(1)}s` : 'Once'}</output></span>
          <input className="range" aria-label="Sweep Every" type="range" min="0" max="30" step=".5"
            value={interval} onChange={event => setIntervalSeconds(event.target.value)} />
        </label>
        <label className="control">
          <span className="control-label"><span>Speed</span><output>{stringsPerSecond} strings/s</output></span>
          {speedInput}
        </label>
        <label className="control">
          <span className="control-label"><span>Volume</span><output>{volume}</output></span>
          <input className="range" aria-label="Volume" type="range" min="0" max="100" value={volume}
            onChange={event => setVolume(Number(event.target.value))} />
        </label>
        {error && <p role="alert">Swarmandal audio could not start.</p>}
      </section>
    );
  }

  function trigger(order: Direction) {
    setDirection(order);
    setAuto(repeat);
    void strum(order);
  }

  const sliders = [
    { label: 'Volume', value: volume, min: 0, max: 100, step: 1, change: setVolume, text: `${volume}%` },
    { label: 'Ring', value: ring, min: .6, max: 10, step: .2, change: setRing, text: `${ring.toFixed(1)}s` },
    { label: 'Room', value: room, min: 0, max: 1, step: .05, change: setRoom, text: `${Math.round(room * 100)}%` },
  ];

  return (
    <section className="swarmandal-studio" aria-labelledby="swarmandal-heading">
      <h1 id="swarmandal-heading">Swarmandal</h1>
      <div className="swarmandal-console">
        <div className="swarmandal-selects">
          <label className="control"><span className="control-label">Root (Sa)</span>
            <select aria-label="Root (Sa)" value={note} onChange={event => onNoteChange?.(event.target.value)}>
              {SA_KEYS.map(key => <option key={key}>{key}</option>)}
            </select>
          </label>
          <label className="control"><span className="control-label">Sound</span>
            <select aria-label="Sound" value={sound} onChange={event => setSound(event.target.value as SwarmandalSound)}>
              <option value="acoustic">Plucked string</option>
              <option value="pad">Synth pad</option>
            </select>
          </label>
          {ragaPicker}
        </div>
        <div className="swarmandal-console-grid">
          <div className="swarmandal-automation">
            <div className="swarmandal-automation-head">
              <h2>Auto mode</h2>
              <label><input type="checkbox" role="switch" aria-label="Repeat" checked={repeat}
                onChange={event => {
                  setRepeat(event.target.checked);
                  if (!event.target.checked) setAuto(false);
                }} /> Repeat</label>
            </div>
            <div className="swarmandal-sweeps">
              <button type="button" aria-label="Strum up" aria-pressed={direction === 'up'} onClick={() => trigger('up')}>L → R</button>
              <button type="button" aria-label="Strum down" aria-pressed={direction === 'down'} onClick={() => trigger('down')}>R → L</button>
              <button type="button" aria-pressed={direction === 'pakad'} onClick={() => trigger('pakad')}>Pakad</button>
            </div>
            <label className="swarmandal-slider"><span>Every</span>
              <input className="range" type="range" aria-label="Every" min="1" max="30" step=".5"
                value={interval} onChange={event => setIntervalSeconds(event.target.value)} />
              <output>{seconds}s</output>
            </label>
            <label className="swarmandal-slider"><span>Speed</span>
              {speedInput}
              <output>{stringsPerSecond}/s</output>
            </label>
          </div>
          <div className="swarmandal-tone">
            <h2>Tone</h2>
            {sliders.map(({ label, value, min, max, step, change, text }) => (
              <label key={label} className="swarmandal-slider"><span>{label}</span>
                <input className="range" type="range" aria-label={label} value={value} min={min} max={max} step={step}
                  onChange={event => change(Number(event.target.value))} />
                <output>{text}</output>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="swarmandal-soundboard">
        <div className="swarmandal-strings" role="group" aria-label="Swarmandal strings" onPointerMove={moveAcrossStrings} onPointerUp={moveAcrossStrings}
          onLostPointerCapture={() => { gesture.current = null; }}>
          {strings.map((string, index) => (
            <button type="button" key={index} data-string={index} aria-label={`String ${index+1}, ${string.name}`}
              ref={element => { if(element) stringButtons.current.set(index,element); else stringButtons.current.delete(index); }}
              className={string.name === 'Sa' ? 'tonic' : undefined}
              onPointerDown={event => {
                if (!event.isPrimary || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                gesture.current = { pointer: event.pointerId, string: index };
                void play([index]);
              }}
              onClick={event => { if (event.detail === 0) void play([index]); }}><span aria-hidden="true" /></button>
          ))}
        </div>
      </div>
      <footer className="swarmandal-studio-footer">
        <p className="swarmandal-status">{auto ? `Repeating every ${seconds}s · ${sweeps} sweeps` : 'Tap or drag across the strings'}</p>
        {active && <button type="button" onClick={stop}>Stop Swarmandal</button>}
      </footer>
      {error && <p role="alert">Swarmandal audio could not start. Try again.</p>}
    </section>
  );
}
