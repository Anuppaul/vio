'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FLAT_NAMES, NOTE_NAMES, midiFrequency } from '@/lib/music';

const ranges = [62,69,76,83].map(top => Array.from({length:15},(_,i)=>top-i));
const presets: Record<string, number[]> = { standard:[55,62,69,76], aeae:[57,64,69,76], adae:[57,62,69,76], pasapasa:[55,60,67,72] };

function displayName(midi:number, flats:boolean, octave=true){
  const names=flats?FLAT_NAMES:NOTE_NAMES;
  const name=names[((midi%12)+12)%12];
  return octave?`${name}${Math.floor(midi/12)-1}`:name;
}
function asciiCandidates(midi:number){
  const sharps=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const flats=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const pc=((midi%12)+12)%12,oct=Math.floor(midi/12)-1,sharp=`${sharps[pc]}${oct}`,flat=`${flats[pc]}${oct}`;
  const names=[sharp,flat,String(midi),`${pc}_${oct}`];
  if(sharp.includes('#')){const l=sharp[0];names.unshift(`${l}s${oct}`,`${l}sharp${oct}`,`${l}-sharp${oct}`)}
  return [...new Set(names)].map(n=>`/assets/ear/${encodeURIComponent(n)}.mp3`);
}

export default function EarTuner(){
  const [notes,setNotes]=useState([55,62,69,76]);
  const [tone,setTone]=useState<'natural'|'beep'>('natural');
  const [flats,setFlats]=useState(false);
  const [loop,setLoop]=useState(true);
  const [volume,setVolume]=useState(.7);
  const [active,setActive]=useState(-1);
  const [status,setStatus]=useState('Ready');
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const ctxRef=useRef<AudioContext|null>(null);
  const oscRef=useRef<OscillatorNode|null>(null);
  const gainRef=useRef<GainNode|null>(null);
  const tokenRef=useRef(0);

  const preset=useMemo(()=>Object.entries(presets).find(([,v])=>v.every((n,i)=>n===notes[i]))?.[0]||'', [notes]);

  function stop(update=true){
    tokenRef.current++;
    if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}
    try{oscRef.current?.stop()}catch{}
    oscRef.current=null;gainRef.current=null;setActive(-1);if(update)setStatus('Stopped');
  }
  useEffect(()=>()=>stop(false),[]);

  async function beep(midi:number,index:number){
    const AC=window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
    if(!AC){setStatus('Web Audio unavailable');return}
    const ctx=ctxRef.current||(ctxRef.current=new AC());
    if(ctx.state==='suspended')await ctx.resume();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type='sine';osc.frequency.value=midiFrequency(midi);gain.gain.value=volume*.5;osc.connect(gain).connect(ctx.destination);osc.start();oscRef.current=osc;gainRef.current=gain;setActive(index);setStatus(`${displayName(midi,flats)} · ${midiFrequency(midi).toFixed(2)} Hz`);
    if(!loop)setTimeout(()=>{if(oscRef.current===osc)stop(false)},1800);
  }

  function playSample(midi:number,index:number){
    stop(false);const token=tokenRef.current;const urls=asciiCandidates(midi);let i=0;
    const attempt=()=>{
      if(token!==tokenRef.current)return;
      if(i>=urls.length){beep(midi,index);setStatus(`${displayName(midi,flats)} · oscillator fallback`);return}
      const audio=new Audio(urls[i]);audio.loop=loop;audio.volume=volume;audioRef.current=audio;
      audio.onended=()=>{if(!loop){setActive(-1);setStatus('Ready')}};
      audio.play().then(()=>{setActive(index);setStatus(`${displayName(midi,flats)} · natural sample`)}).catch(()=>{i++;attempt()});
    };attempt();
  }
  function playMidi(midi:number,index:number){
    if(tone==='natural')playSample(midi,index);
    else{stop(false);void beep(midi,index)}
  }
  function play(index:number){playMidi(notes[index],index)}
  function selectNote(index:number,midi:number){
    const wasPlaying=active===index;
    setNotes(v=>v.map((n,i)=>i===index?midi:n));
    if(wasPlaying)playMidi(midi,index);
  }

  return <>
    <div className="page-head"><div><p className="eyebrow">Reference tuner</p><h1>Ear Tuner</h1><p>Choose a note for each string and match the reference tone.</p></div><div className="badge">G · D · A · E</div></div>
    <section className="card">
      <div className="card-head"><div><h2>String reference</h2></div><span>{status}</span></div>
      <div className="grid-2">
        <div className="section">
          <div className="string-heads"><span>String 4</span><span>String 3</span><span>String 2</span><span>String 1</span></div>
          <div className="note-grid">{Array.from({length:15},(_,row)=>ranges.map((range,s)=>{const midi=range[row];return <button key={`${s}-${midi}`} className={`note-cell ${notes[s]===midi?'active':''}`} onClick={()=>selectNote(s,midi)}>{displayName(midi,flats)}</button>}))}</div>
          <div className="players">{notes.map((midi,i)=><div className="player-card" key={i}><b>{displayName(midi,flats,false)}</b><small>{displayName(midi,flats)} · {midiFrequency(midi).toFixed(2)} Hz</small><button className={active===i?'active':''} onClick={()=>active===i?stop():play(i)}>{active===i?'STOP':'PLAY'}</button></div>)}</div>
        </div>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Tuning</span></div><select value={preset} onChange={e=>{if(e.target.value)setNotes([...presets[e.target.value]])}}><option value="">Custom</option><option value="standard">Standard · G D A E</option><option value="aeae">Cross · A E A E</option><option value="adae">Cross · A D A E</option><option value="pasapasa">Cross · G C G C · পা সা পা সা</option></select></div>
          <div className="control"><div className="control-label"><span>Tone</span></div><div className="seg two"><button className={tone==='natural'?'active':''} onClick={()=>setTone('natural')}>Natural</button><button className={tone==='beep'?'active':''} onClick={()=>setTone('beep')}>Beep</button></div></div>
          <div className="control"><div className="control-label"><span>Notation</span></div><div className="seg two"><button className={!flats?'active':''} onClick={()=>setFlats(false)}>Sharps ♯</button><button className={flats?'active':''} onClick={()=>setFlats(true)}>Flats ♭</button></div></div>
          <div className="control"><div className="control-label"><span>Repeat</span></div><div className="seg two"><button className={loop?'active':''} onClick={()=>setLoop(true)}>Loop</button><button className={!loop?'active':''} onClick={()=>setLoop(false)}>Once</button></div></div>
          <div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>{const v=+e.target.value/100;setVolume(v);if(audioRef.current)audioRef.current.volume=v;if(gainRef.current)gainRef.current.gain.value=v*.5}}/></div>
          <button className="primary danger" onClick={()=>stop()}>Stop sound</button>
        </aside>
      </div>
    </section>
  </>;
}
