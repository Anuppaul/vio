'use client';

import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { PitchDetector } from 'pitchy';
import { OPEN_STRINGS, midiFrequency, noteFromFrequencyRange, rms } from '@/lib/music';

const OPEN_LABELS=['G3','D4','A4','E5'];
const BUFFER_SIZE=32768;
const ANALYSIS_MS=60;
const BACKGROUND_LEARN_MS=1200;
const BACKGROUND_TONE_CENTS=55;
const FOREGROUND_CONFIRM_FRAMES=2;
const FOREGROUND_HOLD_MS=520;

type NativePermissionState='prompt'|'prompt-with-rationale'|'granted'|'denied';
type NativePitchSample={frequency:number;rms:number;confidence:number;sampleRate:number;source:string};
type NativePitchPlugin={
  checkPermissions():Promise<{microphone?:NativePermissionState}>;
  requestPermissions(options:{permissions:string[]}):Promise<{microphone?:NativePermissionState}>;
  start():Promise<{sampleRate:number;source:string}>;
  stop():Promise<void>;
  addListener(eventName:'pitch',listener:(sample:NativePitchSample)=>void):Promise<PluginListenerHandle>;
};
const NativePitch=registerPlugin<NativePitchPlugin>('NativePitch');
function hasNativePitch(){return Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('NativePitch')}

function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}
function prepareSensitiveFrame(input:Float32Array,output:Float32Array){
  let mean=0;for(let i=0;i<input.length;i++)mean+=input[i];mean/=input.length;
  let sum=0,peak=0;
  for(let i=0;i<input.length;i++){const v=input[i]-mean;sum+=v*v;peak=Math.max(peak,Math.abs(v))}
  const frameRms=Math.sqrt(sum/input.length);
  const targetRms=.30,maxGain=64,maxPeak=.92;
  const rmsGain=frameRms>0?targetRms/frameRms:1;
  const peakGain=peak>0?maxPeak/peak:1;
  const gain=Math.max(1,Math.min(maxGain,rmsGain,peakGain));
  for(let i=0;i<input.length;i++)output[i]=(input[i]-mean)*gain;
}
function centsApart(a:number,b:number){return a>0&&b>0?Math.abs(1200*Math.log2(a/b)):Infinity}
type BackgroundGate={
  startedAt:number;
  noiseFloor:number;
  backgroundTones:number[];
  candidate:number;
  candidateFrames:number;
  rejected:number;
  rejectedFrames:number;
  foregroundUntil:number;
};
function createBackgroundGate(now=0):BackgroundGate{return{startedAt:now,noiseFloor:0,backgroundTones:[],candidate:0,candidateFrames:0,rejected:0,rejectedFrames:0,foregroundUntil:0}}
function learnBackgroundTone(gate:BackgroundGate,frequency:number){
  if(!(frequency>0))return;
  const index=gate.backgroundTones.findIndex(value=>centsApart(value,frequency)<=BACKGROUND_TONE_CENTS);
  if(index>=0){gate.backgroundTones[index]=Math.sqrt(gate.backgroundTones[index]*frequency);return}
  if(gate.backgroundTones.length<6)gate.backgroundTones.push(frequency);
}
function backgroundHasPitch(gate:BackgroundGate,frequency:number){return gate.backgroundTones.some(value=>centsApart(value,frequency)<=BACKGROUND_TONE_CENTS)}
function foregroundFrequency(gate:BackgroundGate,frequency:number,clarity:number,inputRms:number,now:number){
  if(gate.noiseFloor<=0)gate.noiseFloor=Math.max(inputRms,1e-7);
  if(now-gate.startedAt<BACKGROUND_LEARN_MS){
    gate.noiseFloor=gate.noiseFloor*.90+inputRms*.10;
    if(frequency>0&&clarity>=.35)learnBackgroundTone(gate,frequency);
    gate.candidate=0;gate.candidateFrames=0;
    return 0;
  }

  const floor=Math.max(gate.noiseFloor,1e-7);
  const energyRise=inputRms>=floor*1.08;
  const novelPitch=frequency>0&&!backgroundHasPitch(gate,frequency);
  const tonal=frequency>0&&clarity>=.36;
  const possibleForeground=tonal&&(energyRise||novelPitch);

  if(now<gate.foregroundUntil&&tonal){
    gate.candidate=frequency;gate.candidateFrames=FOREGROUND_CONFIRM_FRAMES;
    return frequency;
  }

  if(possibleForeground){
    if(gate.candidate>0&&centsApart(gate.candidate,frequency)<=45)gate.candidateFrames++;
    else{gate.candidate=frequency;gate.candidateFrames=1}
    gate.candidate=Math.sqrt(gate.candidate*frequency);
    if(gate.candidateFrames>=FOREGROUND_CONFIRM_FRAMES){
      gate.foregroundUntil=now+FOREGROUND_HOLD_MS;
      gate.rejected=0;gate.rejectedFrames=0;
      return frequency;
    }
  }else{
    gate.candidate=0;gate.candidateFrames=0;
  }

  if(tonal){
    if(gate.rejected>0&&centsApart(gate.rejected,frequency)<=BACKGROUND_TONE_CENTS)gate.rejectedFrames++;
    else{gate.rejected=frequency;gate.rejectedFrames=1}
    gate.rejected=Math.sqrt(gate.rejected*frequency);
    if(gate.rejectedFrames>=10){
      learnBackgroundTone(gate,gate.rejected);
      gate.rejected=0;gate.rejectedFrames=0;
    }
  }else{
    gate.rejected=0;gate.rejectedFrames=0;
  }

  if(inputRms<=floor*1.35)gate.noiseFloor=gate.noiseFloor*.985+inputRms*.015;
  return 0;
}

export default function SoundTuner(){
  const [a4,setA4]=useState(440);
  const [running,setRunning]=useState(false);
  const [note,setNote]=useState('—');
  const [frequency,setFrequency]=useState<number|null>(null);
  const [cents,setCents]=useState<number|null>(null);
  const [micLevel,setMicLevel]=useState(0);
  const [status,setStatus]=useState('Ready');
  const [activeRef,setActiveRef]=useState<number|null>(null);
  const [loop,setLoop]=useState(false);

  const ctxRef=useRef<AudioContext|null>(null);
  const analyserRef=useRef<AnalyserNode|null>(null);
  const sourceRef=useRef<MediaStreamAudioSourceNode|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE));
  const analysisBufferRef=useRef(new Float32Array(BUFFER_SIZE));
  const rafRef=useRef(0),lastRef=useRef(0);
  const detectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const nativeListenerRef=useRef<PluginListenerHandle|null>(null),nativeActiveRef=useRef(false),a4Ref=useRef(a4);
  const backgroundGateRef=useRef<BackgroundGate>(createBackgroundGate());
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  if(!detectorRef.current){
    const detector=PitchDetector.forFloat32Array(BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.55;
    detectorRef.current=detector;
  }
  useEffect(()=>{a4Ref.current=a4},[a4]);

  function clearPitch(){setNote('—');setFrequency(null);setCents(null)}
  function stopReference(){if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}try{oscRef.current?.stop()}catch{}oscRef.current=null;gainRef.current=null;setActiveRef(null)}

  async function playReference(midi:number){
    stopReference();setActiveRef(midi);const label=OPEN_LABELS[OPEN_STRINGS.indexOf(midi as typeof OPEN_STRINGS[number])];
    const sample=`/assets/ear/${label}.mp3`,audio=new Audio(sample);audio.loop=loop;audio.volume=.72;audio.playbackRate=a4/440;audioRef.current=audio;
    try{await audio.play();setStatus(`Reference ${label} · ${midiFrequency(midi,a4).toFixed(2)} Hz`)}catch{
      const AC=audioContextCtor();if(!AC){setStatus('Web Audio unavailable');return}
      const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
      const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=midiFrequency(midi,a4);osc.type='sine';gain.gain.value=.13;osc.connect(gain).connect(ctx.destination);osc.start();oscRef.current=osc;gainRef.current=gain;setStatus(`Reference ${label} · oscillator`);if(!loop)setTimeout(()=>{try{osc.stop()}catch{}setActiveRef(null)},2000)
    }
  }

  function applyPitch(rawFrequency:number,rawRms:number){
    setMicLevel(levelPercent(rawRms));
    const mapped=rawFrequency>0?noteFromFrequencyRange(rawFrequency,a4Ref.current):null;
    if(mapped){
      setNote(mapped.label);setFrequency(rawFrequency);setCents(mapped.cents);setStatus(`Raw pitch · ${mapped.label}`);
    }else{
      clearPitch();setStatus('Listening · no pitch detected');
    }
  }

  function analyse(ts:number){
    const analyser=analyserRef.current,ctx=ctxRef.current,detector=detectorRef.current;if(!analyser||!ctx||!detector)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;
      const input=bufferRef.current;analyser.getFloatTimeDomainData(input);
      const inputRms=rms(input),analysis=analysisBufferRef.current;
      prepareSensitiveFrame(input,analysis);
      const [rawFrequency,clarity]=detector.findPitch(analysis,ctx.sampleRate);
      const accepted=foregroundFrequency(backgroundGateRef.current,rawFrequency>0?rawFrequency:0,clarity,inputRms,ts);
      applyPitch(accepted,inputRms);
    }
    rafRef.current=requestAnimationFrame(analyse);
  }

  async function startNativePitch(){
    const current=await NativePitch.checkPermissions();
    let microphone=current.microphone;
    if(microphone!=='granted'){
      const requested=await NativePitch.requestPermissions({permissions:['microphone']});
      microphone=requested.microphone;
    }
    if(microphone!=='granted')throw new Error('microphone permission denied');
    const listener=await NativePitch.addListener('pitch',sample=>applyPitch(sample.frequency>0?sample.frequency:0,sample.rms));
    nativeListenerRef.current=listener;
    try{
      await NativePitch.start();
      nativeActiveRef.current=true;setRunning(true);clearPitch();setMicLevel(0);setStatus('Listening · raw microphone pitch');
    }catch(err){
      nativeListenerRef.current=null;await listener.remove();throw err;
    }
  }

  async function start(){
    if(running)return;stopReference();
    if(hasNativePitch()){
      try{await startNativePitch()}catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
      return;
    }
    const AC=audioContextCtor();if(!AC||!navigator.mediaDevices?.getUserMedia){setStatus('Microphone API unavailable');return}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();
      analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;
      source.connect(analyser);
      streamRef.current=stream;sourceRef.current=source;analyserRef.current=analyser;
      backgroundGateRef.current=createBackgroundGate(performance.now());
      setRunning(true);clearPitch();setMicLevel(0);setStatus('Listening · learning room background');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }

  function stop(){
    if(nativeActiveRef.current||nativeListenerRef.current){
      nativeActiveRef.current=false;
      const listener=nativeListenerRef.current;nativeListenerRef.current=null;
      if(listener)void listener.remove();
      void NativePitch.stop().catch(()=>{});
      setRunning(false);setMicLevel(0);clearPitch();setStatus('Microphone stopped');return;
    }
    cancelAnimationFrame(rafRef.current);rafRef.current=0;
    try{sourceRef.current?.disconnect();analyserRef.current?.disconnect()}catch{}
    streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;analyserRef.current=null;streamRef.current=null;
    setRunning(false);setMicLevel(0);clearPitch();setStatus('Microphone stopped');
  }

  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop());if(nativeListenerRef.current)void nativeListenerRef.current.remove();if(nativeActiveRef.current)void NativePitch.stop().catch(()=>{});stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  const activeRange=frequency?noteFromFrequencyRange(frequency,a4):null;
  const activeMidi=activeRange?activeRange.midi:null;

  return <>
    <div className="page-head"><div><p className="eyebrow">Raw live tuner</p><h1>Sound Tuner</h1><p>Raw microphone capture is preserved. Far-field tuning preserves raw capture, learns the persistent room background, and accepts a new sustained foreground pitch above that learned profile. The detector still uses the maximum analysis window plus bounded analysis-only normalization. No Android noise suppression, AGC, HPS or octave correction is applied.</p></div><div className="badge">Raw mic → pitch → note</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap jelly-gauge">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?'Play a steady tone':inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row">{OPEN_STRINGS.map((midi,i)=><span className={`target-chip ${activeMidi===midi?'active':''}`} key={midi}>{OPEN_LABELS[i]} · {midiFrequency(midi,a4).toFixed(1)} Hz</span>)}</div>
        </main>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Reference A4</span><span>{a4.toFixed(1)} Hz</span></div><input className="range" type="range" min="415" max="466" step=".1" value={a4} onChange={e=>setA4(+e.target.value)}/><div className="seg three"><button onClick={()=>setA4(415)} className={a4===415?'active':''}>415</button><button onClick={()=>setA4(440)} className={a4===440?'active':''}>440</button><button onClick={()=>setA4(442)} className={a4===442?'active':''}>442</button></div></div>
          <div className="control"><div className="control-label"><span>Quick reference tones</span></div><div className="seg four">{OPEN_STRINGS.map((midi,i)=><button key={midi} className={activeRef===midi?'active':''} onClick={()=>activeRef===midi?stopReference():playReference(midi)}>{OPEN_LABELS[i]}</button>)}</div><label className="toggle" style={{marginTop:9}}><span>Loop reference</span><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);if(audioRef.current)audioRef.current.loop=e.target.checked}}/></label></div>
          <div className="control"><div className="status">{status}</div></div>
          <button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start tuning'}</button>
        </aside>
      </div>
    </section>
  </>;
}
