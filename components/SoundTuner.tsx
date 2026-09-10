'use client';

import { useEffect, useRef, useState } from 'react';
import { OPEN_STRINGS, median, midiFrequency, noteFromFrequency, rms } from '@/lib/music';
import { detectPitch } from '@/lib/yin';

const OPEN_LABELS=['G3','D4','A4','E5'];
const BUFFER_SIZE=4096;
const ANALYSIS_MS=30;
const RMS_MIN=.0012;
const ACCEPT_CLARITY=.28;
const STRONG_CLARITY=.72;

function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}

export default function SoundTuner(){
  const [a4,setA4]=useState(440);
  const [running,setRunning]=useState(false);
  const [note,setNote]=useState('—');
  const [frequency,setFrequency]=useState<number|null>(null);
  const [cents,setCents]=useState<number|null>(null);
  const [clarity,setClarity]=useState(0);
  const [micLevel,setMicLevel]=useState(0);
  const [status,setStatus]=useState('Ready');
  const [activeRef,setActiveRef]=useState<number|null>(null);
  const [loop,setLoop]=useState(false);
  const ctxRef=useRef<AudioContext|null>(null), analyserRef=useRef<AnalyserNode|null>(null), sourceRef=useRef<MediaStreamAudioSourceNode|null>(null), streamRef=useRef<MediaStream|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE));
  const rafRef=useRef(0),lastRef=useRef(0),missRef=useRef(0),historyRef=useRef<number[]>([]),pendingMidiRef=useRef<number|null>(null),pendingCountRef=useRef(0),lockedMidiRef=useRef<number|null>(null),lastStatusRef=useRef('');
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  function clearPitch(){setNote('—');setFrequency(null);setCents(null);setClarity(0);historyRef.current=[];pendingMidiRef.current=null;pendingCountRef.current=0;lockedMidiRef.current=null}
  function resetReading(){clearPitch();setMicLevel(0);missRef.current=0}
  function setLiveStatus(text:string){if(lastStatusRef.current===text)return;lastStatusRef.current=text;setStatus(text)}
  function stopReference(){if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}try{oscRef.current?.stop()}catch{}oscRef.current=null;gainRef.current=null;setActiveRef(null)}
  async function playReference(midi:number){
    stopReference();setActiveRef(midi);const label=OPEN_LABELS[OPEN_STRINGS.indexOf(midi as typeof OPEN_STRINGS[number])];
    const sample=`/assets/ear/${label}.mp3`,audio=new Audio(sample);audio.loop=loop;audio.volume=.72;audio.playbackRate=a4/440;audioRef.current=audio;
    try{await audio.play();setStatus(`Reference ${label} · ${midiFrequency(midi,a4).toFixed(2)} Hz`)}catch{
      const AC=audioContextCtor();if(!AC){setStatus('Web Audio unavailable');return}const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=midiFrequency(midi,a4);osc.type='sine';gain.gain.value=.13;osc.connect(gain).connect(ctx.destination);osc.start();oscRef.current=osc;gainRef.current=gain;setStatus(`Reference ${label} · oscillator`);if(!loop)setTimeout(()=>{try{osc.stop()}catch{}setActiveRef(null)},2000)
    }
  }

  function acceptPitch(raw:number,quality:number){
    const immediate=noteFromFrequency(raw,a4),midi=immediate.midi;
    if(lockedMidiRef.current!==midi){
      if(quality>=STRONG_CLARITY){lockedMidiRef.current=midi;pendingMidiRef.current=null;pendingCountRef.current=0;historyRef.current=[]}
      else{
        if(pendingMidiRef.current===midi)pendingCountRef.current++;else{pendingMidiRef.current=midi;pendingCountRef.current=1}
        if(pendingCountRef.current<2)return;
        lockedMidiRef.current=midi;pendingMidiRef.current=null;pendingCountRef.current=0;historyRef.current=[];
      }
    }
    historyRef.current.push(raw);if(historyRef.current.length>3)historyRef.current.shift();
    const stable=median(historyRef.current),mapped=noteFromFrequency(stable,a4);
    setNote(mapped.label);setFrequency(stable);setCents(mapped.cents);setClarity(quality);missRef.current=0;setLiveStatus(`Pitch locked · ${mapped.label}`);
  }

  function analyse(ts:number){
    const analyser=analyserRef.current,ctx=ctxRef.current;if(!analyser||!ctx)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;const buffer=bufferRef.current;analyser.getFloatTimeDomainData(buffer);
      const volume=rms(buffer),level=levelPercent(volume);setMicLevel(level);
      if(volume>=RMS_MIN){
        const result=detectPitch(buffer,ctx.sampleRate,150,1800);
        const quality=result?.clarity??0;setClarity(quality);
        if(result&&quality>=ACCEPT_CLARITY)acceptPitch(result.frequency,quality);
        else if(result){
          const midi=noteFromFrequency(result.frequency,a4).midi;
          if(pendingMidiRef.current===midi)pendingCountRef.current++;else{pendingMidiRef.current=midi;pendingCountRef.current=1}
          if(pendingCountRef.current>=3)acceptPitch(result.frequency,Math.max(.2,quality));
          else setLiveStatus(`Pitch candidate · ${result.source}`);
        }else{
          missRef.current++;setLiveStatus('Mic active · finding pitch');
          if(missRef.current>14)clearPitch();
        }
      }else{
        missRef.current++;setClarity(0);setLiveStatus(level>0?'Very low mic signal':'Listening · play a note');
        if(missRef.current>14)clearPitch();
      }
    }
    rafRef.current=requestAnimationFrame(analyse);
  }

  async function start(){
    if(running)return;stopReference();const AC=audioContextCtor();if(!AC||!navigator.mediaDevices?.getUserMedia){setStatus('Microphone API unavailable');return}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;source.connect(analyser);streamRef.current=stream;sourceRef.current=source;analyserRef.current=analyser;setRunning(true);resetReading();lastStatusRef.current='';setLiveStatus('Listening · play a note');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }
  function stop(){cancelAnimationFrame(rafRef.current);rafRef.current=0;try{sourceRef.current?.disconnect()}catch{}streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;streamRef.current=null;analyserRef.current=null;setRunning(false);resetReading();lastStatusRef.current='';setStatus('Microphone stopped')}
  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop());stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  const activePitchClass=frequency?noteFromFrequency(frequency,a4).midi%12:null;

  return <>
    <div className="page-head"><div><p className="eyebrow">Live microphone tuner</p><h1>Sound Tuner</h1><p>Live microphone frequency is detected locally and mapped directly to note and cents.</p></div><div className="badge">Frequency → note → cents</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}% · Pitch ${Math.round(clarity*100)}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?(micLevel>2?'Sound detected · finding note':'Play a clear note'):inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row">{OPEN_STRINGS.map((midi,i)=><span className={`target-chip ${activePitchClass===midi%12?'active':''}`} key={midi}>{OPEN_LABELS[i]} · {midiFrequency(midi,a4).toFixed(1)} Hz</span>)}</div>
        </main>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Reference A4</span><span>{a4.toFixed(1)} Hz</span></div><input className="range" type="range" min="415" max="466" step=".1" value={a4} onChange={e=>{setA4(+e.target.value);historyRef.current=[];lockedMidiRef.current=null}}/><div className="seg three"><button onClick={()=>setA4(415)} className={a4===415?'active':''}>415</button><button onClick={()=>setA4(440)} className={a4===440?'active':''}>440</button><button onClick={()=>setA4(442)} className={a4===442?'active':''}>442</button></div></div>
          <div className="control"><div className="control-label"><span>Reference strings</span></div><div className="seg four">{OPEN_STRINGS.map((midi,i)=><button key={midi} className={activeRef===midi?'active':''} onClick={()=>activeRef===midi?stopReference():playReference(midi)}>{OPEN_LABELS[i]}</button>)}</div><label className="toggle" style={{marginTop:9}}><span>Loop reference</span><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);if(audioRef.current)audioRef.current.loop=e.target.checked}}/></label></div>
          <div className="control"><div className="status">{status}</div></div>
          <button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start tuning'}</button>
        </aside>
      </div>
    </section>
  </>;
}
