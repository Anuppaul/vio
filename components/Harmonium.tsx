'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { resumeBrowserAudio } from '@/lib/browser-audio';
import type { MixerChannel } from '@/lib/mixer-channel';
import type { BaithakAudio } from '@/lib/baithak-audio';

const DRONES = {
  sa: { label: 'Sa', notes: [0] },
  pa: { label: 'Sa + Pa', notes: [0, 7] },
  ma: { label: 'Sa + Ma', notes: [0, 5] },
  octave: { label: 'Sa + Pa + upper Sa', notes: [0, 7, 12] },
};
const REEDS = {
  bass: { label: 'Bass · 16′', ratio: .5, harmonics: [1, .31, .16, .07, .04] },
  male: { label: 'Male · 8′', ratio: 1, harmonics: [1, .47, .28, .13, .08] },
  female: { label: 'Female · 4′', ratio: 2, harmonics: [1, .61, .33, .22, .16] },
};
const SWARS = ['Sa', 're', 'Re', 'ga', 'Ga', 'Ma', 'Ma♯', 'Pa', 'dha', 'Dha', 'ni', 'Ni'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const KEY_OFFSETS = Array.from({ length: 37 }, (_, index) => index - 12);
const WHITE_KEYS = KEY_OFFSETS.filter(offset => !BLACK_KEYS.has((offset + 12) % 12));
const SHORTCUTS = 'awsedftgyhujkolp;';
type Mode = 'drone' | 'keyboard';
type Voice = { oscillator: OscillatorNode; envelope: GainNode; offset: number };
type Session = {
  context: AudioContext;
  gain: GainNode;
  oscillators: Set<OscillatorNode>;
  voices: Map<string, Voice>;
  pending: Map<string, symbol>;
  waves: Map<keyof typeof REEDS, PeriodicWave>;
};

export default function Harmonium({ frequency, channel, enabled, mixAudio }: {
  frequency: number;
  channel: Ref<MixerChannel>;
  enabled: boolean;
  mixAudio: BaithakAudio;
}) {
  const [mode, setMode] = useState<Mode>('drone');
  const [reed, setReed] = useState<keyof typeof REEDS>('male');
  const [drone, setDrone] = useState<keyof typeof DRONES>('pa');
  const [volume, setVolume] = useState(46);
  const [error, setError] = useState(false);
  const [pressed, setPressed] = useState<number[]>([]);
  const audio = useRef<Session | null>(null);
  const keyboardScroll = useRef<HTMLDivElement>(null);
  const settings = useRef({ frequency, reed, volume });

  function release() {
    const session = audio.current;
    audio.current = null;
    if (!session) return;
    for (const oscillator of session.oscillators) oscillator.stop();
    session.gain.disconnect();
  }

  function stop() {
    release();
    setPressed([]);
  }

  function endVoice(id: string) {
    const session = audio.current;
    if (!session) return;
    session.pending.delete(id);
    const voice = session.voices.get(id);
    if (!voice) return;
    const now = session.context.currentTime;
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setTargetAtTime(0, now, .024);
    voice.oscillator.stop(now + .14);
    session.voices.delete(id);
    if (!id.startsWith('drone:')) {
      setPressed([...session.voices.entries()].filter(([key]) => !key.startsWith('drone:')).map(([, item]) => item.offset));
    }
  }

  function waveFor(session: Session, register: keyof typeof REEDS) {
    let wave = session.waves.get(register);
    if (!wave) {
      const harmonics = Float32Array.of(0, ...REEDS[register].harmonics);
      wave = session.context.createPeriodicWave(new Float32Array(harmonics.length), harmonics);
      session.waves.set(register, wave);
    }
    return wave;
  }

  async function play(id: string, offset: number) {
    let session = audio.current;
    if (!session) {
      const mix = mixAudio.get();
      if (!mix) { setError(true); return; }
      const { context, output } = mix;
      const gain = context.createGain();
      gain.gain.value = settings.current.volume * .0015;
      gain.connect(output);
      session = { context, gain, oscillators: new Set(), voices: new Map(), pending: new Map(), waves: new Map() };
      audio.current = session;
    }
    if (session.pending.has(id) || session.voices.has(id)) return;
    const { context, gain } = session;
    const request = Symbol();
    session.pending.set(id, request);
    await resumeBrowserAudio(context);
    if (audio.current !== session || session.pending.get(id) !== request) return;
    session.pending.delete(id);
    if (context.state !== 'running') { stop(); setError(true); return; }

    const current = settings.current;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const now = context.currentTime;
    oscillator.setPeriodicWave(waveFor(session, current.reed));
    oscillator.frequency.value = current.frequency * REEDS[current.reed].ratio * 2 ** (offset / 12);
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(id.startsWith('drone:') ? .42 : .85, now + .055);
    oscillator.connect(envelope).connect(gain);
    session.oscillators.add(oscillator);
    oscillator.onended = () => {
      session.oscillators.delete(oscillator);
      oscillator.disconnect();
      envelope.disconnect();
    };
    session.voices.set(id, { oscillator, envelope, offset });
    oscillator.start(now);
    if (!id.startsWith('drone:')) setPressed(previous => [...previous, offset]);
    setError(false);
  }

  function startDrone() {
    if (mode === 'drone') DRONES[drone].notes.forEach(offset => void play(`drone:${offset}`, offset));
  }
  useImperativeHandle(channel, () => ({ start: startDrone, stop }));

  useEffect(() => {
    settings.current = { frequency, reed, volume };
    const session = audio.current;
    if (!session) return;
    const now = session.context.currentTime;
    session.gain.gain.setTargetAtTime(volume * .0015, now, .025);
    for (const voice of session.voices.values()) {
      voice.oscillator.setPeriodicWave(waveFor(session, reed));
      voice.oscillator.frequency.setTargetAtTime(frequency * REEDS[reed].ratio * 2 ** (voice.offset / 12), now, .025);
    }
  }, [frequency, reed, volume]);

  useEffect(() => {
    const session = audio.current;
    if (session) {
      for (const id of [...session.voices.keys(), ...session.pending.keys()]) {
        if (mode === 'drone' || id.startsWith('drone:')) endVoice(id);
      }
    }
    if (enabled) startDrone();
  }, [mode, drone]);

  useEffect(() => {
    function releaseKeys() {
      const session = audio.current;
      if (!session) return;
      for (const id of [...session.voices.keys(), ...session.pending.keys()]) {
        if (!id.startsWith('drone:')) endVoice(id);
      }
    }
    function onVisibility() {
      if (!document.hidden) return;
      stop();
    }
    window.addEventListener('blur', releaseKeys);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseKeys);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, []);

  return (
    <section className="card harmonium-card" aria-labelledby="harmonium-heading">
      <h2 id="harmonium-heading" className="baithak-sr-only">Harmonium</h2>
      <div className="section harmonium-controls">
        <label className="control"><span className="control-label">Mode</span>
          <select aria-label="Harmonium mode" value={mode} onChange={event => setMode(event.target.value as Mode)}>
            <option value="drone">Drone box · sur-peti</option>
            <option value="keyboard">Full harmonium · keyboard</option>
          </select>
        </label>
        <label className="control"><span className="control-label">Reed</span>
          <select aria-label="Reed register" value={reed} onChange={event => setReed(event.target.value as keyof typeof REEDS)}>
            {Object.entries(REEDS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
          </select>
        </label>
        {mode === 'drone' && <label className="control"><span className="control-label">Drone</span>
          <select aria-label="Drone notes" value={drone} onChange={event => setDrone(event.target.value as keyof typeof DRONES)}>
            {Object.entries(DRONES).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
          </select>
        </label>}
        <label className="control"><span className="control-label"><span>Volume</span><span>{volume}%</span></span>
          <input className="range" aria-label="Harmonium volume" type="range" min="0" max="100" value={volume}
            onChange={event => setVolume(Number(event.target.value))} />
        </label>
        {mode === 'keyboard' && <div className="harmonium-keyboard">
          <div className="harmonium-octaves" role="group" aria-label="Show octave">
            {['Lower', 'Middle', 'Upper'].map((label, index) => <button key={label} type="button" onClick={() => {
              const viewport = keyboardScroll.current;
              if (viewport) viewport.scrollLeft = index * (viewport.scrollWidth - viewport.clientWidth) / 2;
            }}>{label}</button>)}
          </div>
          <div className="harmonium-key-scroll" ref={keyboardScroll}>
            <div className="harmonium-piano" role="group" aria-label="Harmonium keyboard" onBlur={event => {
              if (event.currentTarget.contains(event.relatedTarget)) return;
              for (let offset = 0; offset < SHORTCUTS.length; offset++) endVoice(`typing:${offset}`);
            }} onKeyDown={event => {
              const offset = SHORTCUTS.indexOf(event.key.toLowerCase());
              if (offset < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !enabled) return;
              event.preventDefault();
              if (!event.repeat) void play(`typing:${offset}`, offset);
            }} onKeyUp={event => {
              const offset = SHORTCUTS.indexOf(event.key.toLowerCase());
              if (offset >= 0) endVoice(`typing:${offset}`);
            }}>
              {KEY_OFFSETS.map(offset => {
                const swar = SWARS[(offset + 12) % 12];
                const black = BLACK_KEYS.has((offset + 12) % 12);
                const before = WHITE_KEYS.filter(key => key < offset).length;
                const label = offset < 0 ? `Lower ${swar}` : offset >= 24 ? `Highest ${swar}` : offset >= 12 ? `Upper ${swar}` : swar;
                return <button key={offset} type="button" data-harmonium-key
                  aria-label={label} aria-pressed={pressed.includes(offset)} disabled={!enabled}
                  className={black ? 'harmonium-black-key' : undefined}
                  style={black ? { left: `${before / WHITE_KEYS.length * 100}%` } : undefined}
                  onPointerDown={event => {
                    if (event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    void play(`pointer:${event.pointerId}`, offset);
                  }}
                  onLostPointerCapture={event => endVoice(`pointer:${event.pointerId}`)}
                  onKeyDown={event => {
                    if (event.key !== ' ' && event.key !== 'Enter') return;
                    event.preventDefault();
                    void play(`key:${offset}`, offset);
                  }}
                  onKeyUp={event => {
                    if (event.key === ' ' || event.key === 'Enter') endVoice(`key:${offset}`);
                  }}
                  onBlur={() => endVoice(`key:${offset}`)}>{swar}</button>;
              })}
            </div>
          </div>
        </div>}
        {error && <p role="alert">Harmonium audio could not start.</p>}
      </div>
    </section>
  );
}
