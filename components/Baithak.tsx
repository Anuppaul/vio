'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Tanpura from '@/components/Tanpura';
import Tabla from '@/components/Tabla';
import Swarmandal from '@/components/Swarmandal';
import type { MixerChannel } from '@/lib/mixer-channel';
import { BaithakAudio } from '@/lib/baithak-audio';
import SaPicker from '@/components/SaPicker';
import { SA_KEYS, saFrequency } from '@/lib/riyaaz';

const CHANNELS = ['Tanpura', 'Tabla', 'Swarmandal'] as const;
type ChannelName = typeof CHANNELS[number];

const PANEL_LABELS = {
  Tanpura: ['तानपुरा', 'Drone'], Tabla: ['तबला', 'Taal'],
  Swarmandal: ['स्वरमंडल', 'Strings'],
};

const SILENT = { Tanpura: false, Tabla: false, Swarmandal: false };

function SoundSwitch({ label, on, onChange, showState = true }: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  showState?: boolean;
}) {
  return (
    <label className="baithak-switch">
      <input type="checkbox" role="switch" aria-label={label} checked={on}
        onChange={event => onChange(event.target.checked)} />
      {showState && <span aria-hidden="true">{on ? 'On' : 'Off'}</span>}
    </label>
  );
}

function InstrumentStrip({ name, mark, selected, onSelect, children }: {
  name: ChannelName;
  mark: string;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="baithak-strip" data-instrument={name} data-enabled={selected}>
      <header>
        <span className="baithak-mark" aria-hidden="true">{mark}</span>
        <div className="baithak-strip-name">
          <strong>{name}</strong><span lang="hi">{PANEL_LABELS[name][0]}</span>
          <small>{PANEL_LABELS[name][1]}</small>
        </div>
        <SoundSwitch label={`${name} sound`} on={selected} onChange={onSelect} />
      </header>
      {children}
    </div>
  );
}

const WHITE_KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK_KEYS = [['C#', 1], ['D#', 2], ['F#', 4], ['G#', 5], ['A#', 6]] as const;

export default function Baithak({ instrument }: { instrument?: 'tabla' | 'swarmandal' }) {
  const [mixAudio] = useState(() => new BaithakAudio());
  const [note, setNote] = useState('C');
  const [cents, setCents] = useState(0);
  const tuningRatio = 2 ** (cents / 1200);
  const [enabled, setEnabled] = useState(SILENT);
  const lastMix = useRef({ Tanpura: true, Tabla: true, Swarmandal: true });
  const tablaFinished = useRef(false);
  const tanpura = useRef<MixerChannel>(null);
  const tabla = useRef<MixerChannel>(null);
  const swarmandal = useRef<MixerChannel>(null);
  const mixEnabled = CHANNELS.some(name => enabled[name]);
  useEffect(() => {
    if (instrument) return;
    function resumeOnReturn() {
      if (!document.hidden) mixAudio.resume();
    }
    document.addEventListener('visibilitychange', resumeOnReturn);
    window.addEventListener('focus', resumeOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', resumeOnReturn);
      window.removeEventListener('focus', resumeOnReturn);
      mixAudio.close();
    };
  }, [instrument, mixAudio]);
  useEffect(() => {
    if (!mixEnabled) mixAudio.close();
  }, [mixEnabled, mixAudio]);

  if (instrument === 'swarmandal') return <Swarmandal note={note} onNoteChange={setNote} />;

  if (instrument) {
    return (
      <>
        <div className="card section"><SaPicker note={note} onChange={setNote} /></div>
        <Tabla note={note} semitones={SA_KEYS.indexOf(note)} />
      </>
    );
  }

  const channels = { Tanpura: tanpura, Tabla: tabla, Swarmandal: swarmandal };
  function select(name: ChannelName, selected: boolean) {
    if (name === 'Tabla') tablaFinished.current = false;
    setEnabled(previous => ({ ...previous, [name]: selected }));
    if (selected) channels[name].current?.start();
    else channels[name].current?.stop();
  }

  function toggleMix(on: boolean) {
    if (on) {
      const selection = { ...lastMix.current, Tabla: lastMix.current.Tabla || tablaFinished.current };
      tablaFinished.current = false;
      setEnabled(selection);
      CHANNELS.forEach(name => { if (selection[name]) channels[name].current?.start(); });
    } else {
      lastMix.current = { ...enabled, Tabla: enabled.Tabla || tablaFinished.current };
      CHANNELS.forEach(name => channels[name].current?.stop());
      mixAudio.close();
      setEnabled(SILENT);
    }
  }

  return (
    <div className="baithak">
      <header className="baithak-heading"><h1>Taalmala</h1></header>
      <section className="baithak-tuning" aria-labelledby="master-sa">
        <h2 id="master-sa">Master Sa</h2>
        <div className="baithak-tuning-layout">
          <div className="baithak-keyboard" role="group" aria-label="Sa / Key">
            {WHITE_KEYS.map(key => <button type="button" key={key} aria-pressed={note === key}
              onClick={() => setNote(key)}>{key}</button>)}
            {BLACK_KEYS.map(([key, edge]) => <button type="button" key={key} className="baithak-black-key"
              style={{ left: `${edge / 7 * 100}%` }} aria-pressed={note === key} onClick={() => setNote(key)}>{key}</button>)}
          </div>
          <label className="baithak-fine">
            <span><strong>Fine tune</strong><output aria-live="off">{cents > 0 ? '+' : ''}{cents}¢</output></span>
            <input type="range" className="range" aria-label="Fine tune" aria-valuetext={`${cents} cents`}
              min="-50" max="50" value={cents} onChange={event => setCents(Number(event.target.value))} />
            <span><span>A {(440 * tuningRatio).toFixed(1)} Hz</span><span>Sa {(saFrequency(note) * 2 * tuningRatio).toFixed(1)} Hz</span></span>
          </label>
          <div className="baithak-master-mix">
            <strong>Master Mix</strong>
            <SoundSwitch label="Mix sound" showState={false} on={mixEnabled} onChange={toggleMix} />
          </div>
        </div>
      </section>
      <div className="baithak-instruments">
        <InstrumentStrip name="Tanpura" mark="ॐ" selected={enabled.Tanpura} onSelect={value => select('Tanpura', value)}>
          <Tanpura sa={{ note, onChange: setNote }} cents={cents} channel={tanpura} mixAudio={mixAudio} />
        </InstrumentStrip>
        <InstrumentStrip name="Tabla" mark="◉" selected={enabled.Tabla} onSelect={value => select('Tabla', value)}>
          <Tabla note={note} semitones={SA_KEYS.indexOf(note)} cents={cents} channel={tabla} mixAudio={mixAudio}
            onPlaybackEnd={reason => {
              tablaFinished.current = reason === 'complete';
              setEnabled(previous => ({ ...previous, Tabla: false }));
            }} />
        </InstrumentStrip>
        <InstrumentStrip name="Swarmandal" mark="♬" selected={enabled.Swarmandal} onSelect={value => select('Swarmandal', value)}>
          <Swarmandal mode="mix" note={note} cents={cents} channel={swarmandal} mixAudio={mixAudio} />
        </InstrumentStrip>
      </div>
    </div>
  );
}
