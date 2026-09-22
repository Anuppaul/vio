'use client';

import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { PitchDetector } from 'pitchy';
import { OPEN_STRINGS, midiFrequency, noteFromFrequency, rms } from '@/lib/music';
import { detectPitch } from '@/lib/yin';
import { createBrowserAudioContext, requestRawMicrophone, resumeBrowserAudio } from '@/lib/browser-audio';
import {
  OneEuroFilter,
  PitchTracker,
  chooseHarmonicCandidate,
  type PitchCandidate,
  type PitchMode
} from '@/lib/pitch-engine';

const OPEN_LABELS=['G3','D4','A4','E5'];
const BUFFER_SIZE=8192;
const SHORT_BUFFER_SIZE=4096;
const ANALYSIS_MS=16;
const CONSENSUS_MS=96;
const MIN_DETECT_HZ=20;
const MAX_DETECT_HZ=5000;

type NativePermissionState='prompt'|'prompt-with-rationale'|'granted'|'denied';
type NativePitchSample={frequency:number;rms:number;confidence:number;sampleRate:number;source:string;mode?:PitchMode};
type NativePitchError={message:string};
type NativePitchPlugin={
  checkPermissions():Promise<{microphone?:NativePermissionState}>;
  requestPermissions(options:{permissions:string[]}):Promise<{microphone?:NativePermissionState}>;
  start():Promise<{sampleRate:number;source:string}>;
  stop():Promise<void>;
  addListener(eventName:'pitch',listener:(sample:NativePitchSample)=>void):Promise<PluginListenerHandle>;
  addListener(eventName:'error',listener:(error:NativePitchError)=>void):Promise<PluginListenerHandle>;
};
const NativePitch=registerPlugin<NativePitchPlugin>('NativePitch');
function hasNativePitch(){return Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('NativePitch')}

function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}
function segmentRms(buffer:Float32Array,start:number,end:number){
  let sum=0,count=0;for(let i=Math.max(0,start);i<Math.min(buffer.length,end);i++){sum+=buffer[i]*buffer[i];count++}
  return count?Math.sqrt(sum/count):0;
}
function prepareSensitiveFrame(input:Float32Array,output:Float32Array){
  let mean=0;for(let i=0;i<input.length;i++)mean+=input[i];mean/=input.length;
  let sum=0,peak=0;
  for(let i=0;i<input.length;i++){const v=input[i]-mean;sum+=v*v;peak=Math.max(peak,Math.abs(v))}
  const frameRms=Math.sqrt(sum/input.length);
  const targetRms=.32,maxGain=64,maxPeak=.97;
  const rmsGain=frameRms>0?targetRms/frameRms:1;
  const peakGain=peak>0?maxPeak/peak:1;
  const gain=Math.max(1,Math.min(maxGain,rmsGain,peakGain));
  for(let i=0;i<input.length;i++)output[i]=(input[i]-mean)*gain;
}

export default function SoundTuner(){
  const [a4,setA4]=useState(440);
  const [running,setRunning]=useState(false);
  const [note,setNote]=useState('—');
  const [frequency,setFrequency]=useState<number|null>(null);
  const [cents,setCents]=useState<number|null>(null);
  const [needleCents,setNeedleCents]=useState<number|null>(null);
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
  const shortBufferRef=useRef(new Float32Array(SHORT_BUFFER_SIZE));
  const spectrumRef=useRef(new Float32Array(BUFFER_SIZE/2));
  const rafRef=useRef(0),lastRef=useRef(0);
  const detectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const shortDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const trackerRef=useRef(new PitchTracker());
  const needleFilterRef=useRef(new OneEuroFilter());
  const consensusRef=useRef<PitchCandidate|null>(null);
  const consensusAtRef=useRef(0);
  const nativeListenerRef=useRef<PluginListenerHandle|null>(null),nativeErrorListenerRef=useRef<PluginListenerHandle|null>(null),nativeActiveRef=useRef(false),a4Ref=useRef(a4);
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  if(!detectorRef.current){
    const detector=PitchDetector.forFloat32Array(BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.22;
    detectorRef.current=detector;
  }
  if(!shortDetectorRef.current){
    const detector=PitchDetector.forFloat32Array(SHORT_BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.18;
    shortDetectorRef.current=detector;
  }

  useEffect(()=>{
    a4Ref.current=a4;
    if(audioRef.current)audioRef.current.playbackRate=a4/440;
    if(oscRef.current&&ctxRef.current&&activeRef!==null){
      oscRef.current.frequency.setTargetAtTime(midiFrequency(activeRef,a4),ctxRef.current.currentTime,.015);
    }
  },[a4,activeRef]);

  function clearPitch(resetEngine=false){
    if(resetEngine){
      trackerRef.current.reset();needleFilterRef.current.reset();
      consensusRef.current=null;consensusAtRef.current=0;
    }
    setNote('—');setFrequency(null);setCents(null);setNeedleCents(null);
  }

  function stopReference(){
    if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}
    try{oscRef.current?.stop()}catch{}
    oscRef.current=null;gainRef.current=null;setActiveRef(null);
  }

  async function playReference(midi:number){
    stopReference();setActiveRef(midi);
    const label=OPEN_LABELS[OPEN_STRINGS.indexOf(midi as typeof OPEN_STRINGS[number])];
    const sample=`/assets/ear/${label}.mp3`,audio=new Audio(sample);
    audio.loop=loop;audio.volume=.72;audio.playbackRate=a4/440;audioRef.current=audio;
    try{
      await audio.play();
      setStatus(`Reference ${label} · ${midiFrequency(midi,a4).toFixed(2)} Hz`);
    }catch{
      const ctx=ctxRef.current||createBrowserAudioContext();
      if(!ctx){setStatus('Web Audio unavailable');return}
      ctxRef.current=ctx;await resumeBrowserAudio(ctx);
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.frequency.value=midiFrequency(midi,a4);osc.type='sine';gain.gain.value=.13;
      osc.connect(gain).connect(ctx.destination);osc.start();
      oscRef.current=osc;gainRef.current=gain;
      setStatus(`Reference ${label} · oscillator`);
      if(!loop)setTimeout(()=>{try{osc.stop()}catch{}setActiveRef(null)},2000);
    }
  }

  function applyTrackedPitch(rawFrequency:number,rawRms:number,clarity:number,mode:PitchMode,now=performance.now()){
    setMicLevel(levelPercent(rawRms));
    const tracked=trackerRef.current.accept({frequency:rawFrequency,clarity,rms:rawRms,mode,now});
    if(tracked.frequency===null){
      if(tracked.state==='candidate'){
        setStatus('Listening · confirming pitch');
        return;
      }
      clearPitch(false);
      setStatus('Listening · no reliable pitch');
      return;
    }

    const mapped=noteFromFrequency(tracked.frequency,a4Ref.current);
    const filteredCents=needleFilterRef.current.filter(mapped.cents,now);
    setNote(mapped.label);
    setFrequency(tracked.frequency);
    setCents(mapped.cents);
    setNeedleCents(filteredCents);

    if(tracked.state==='transition')setStatus(`Tracking ${mapped.label} · checking note change`);
    else if(tracked.held)setStatus(`Tracking ${mapped.label} · brief dropout held`);
    else setStatus(`${mode==='transient'?'Transient':'Pitch'} · ${mapped.label} · ${Math.round(tracked.confidence*100)}% confidence`);
  }

  function analyse(ts:number){
    const analyser=analyserRef.current,ctx=ctxRef.current,longDetector=detectorRef.current,shortDetector=shortDetectorRef.current;
    if(!analyser||!ctx||!longDetector||!shortDetector)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;
      const input=bufferRef.current;analyser.getFloatTimeDomainData(input);
      const inputRms=rms(input),analysis=analysisBufferRef.current,shortAnalysis=shortBufferRef.current,spectrum=spectrumRef.current;
      prepareSensitiveFrame(input,analysis);
      shortAnalysis.set(analysis.subarray(BUFFER_SIZE-SHORT_BUFFER_SIZE));
      analyser.getFloatFrequencyData(spectrum);

      const [longFrequency,longClarity]=longDetector.findPitch(analysis,ctx.sampleRate);
      const [shortFrequency,shortClarity]=shortDetector.findPitch(shortAnalysis,ctx.sampleRate);
      if(ts-consensusAtRef.current>=CONSENSUS_MS){
        consensusAtRef.current=ts;
        const lowCandidate=longFrequency>0&&longFrequency<90;
        const consensusInput=lowCandidate?analysis:shortAnalysis;
        const consensusMin=lowCandidate?MIN_DETECT_HZ:55;
        const consensusMax=Math.min(MAX_DETECT_HZ,ctx.sampleRate*.45);
        const independent=detectPitch(consensusInput,ctx.sampleRate,consensusMin,consensusMax);
        consensusRef.current=independent
          ?{frequency:independent.frequency,clarity:independent.clarity,mode:'sustained'}
          :null;
      }
      const recentRms=segmentRms(input,BUFFER_SIZE-2048,BUFFER_SIZE);
      const previousRms=segmentRms(input,BUFFER_SIZE-6144,BUFFER_SIZE-2048);
      const onset=recentRms>Math.max(previousRms*1.18,previousRms+0.00018);
      const picked=chooseHarmonicCandidate(
        {frequency:longFrequency>0?longFrequency:0,clarity:longClarity,mode:'sustained'},
        {frequency:shortFrequency>0?shortFrequency:0,clarity:shortClarity,mode:onset?'transient':'sustained'},
        consensusRef.current,
        spectrum,
        ctx.sampleRate,
        MIN_DETECT_HZ,
        MAX_DETECT_HZ
      );
      applyTrackedPitch(picked.frequency,inputRms,picked.clarity,picked.mode,ts);
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
    trackerRef.current.reset();needleFilterRef.current.reset();
    const listener=await NativePitch.addListener('pitch',sample=>{
      applyTrackedPitch(
        sample.frequency>0?sample.frequency:0,
        sample.rms,
        Math.max(0,Math.min(1,sample.confidence||0)),
        sample.mode??'sustained'
      );
    });
    const errorListener=await NativePitch.addListener('error',error=>{
      nativeActiveRef.current=false;
      setRunning(false);setMicLevel(0);clearPitch(true);
      setStatus(`Microphone stopped unexpectedly: ${error.message||'audio capture failed'}`);
    });
    nativeListenerRef.current=listener;
    nativeErrorListenerRef.current=errorListener;
    try{
      await NativePitch.start();
      nativeActiveRef.current=true;setRunning(true);clearPitch(false);setMicLevel(0);
      setStatus('Listening · harmonic-aware tracking ready');
    }catch(err){
      nativeListenerRef.current=null;nativeErrorListenerRef.current=null;
      await listener.remove();await errorListener.remove();throw err;
    }
  }

  async function start(){
    if(running)return;stopReference();
    if(hasNativePitch()){
      try{await startNativePitch()}catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
      return;
    }
    try{
      const stream=await requestRawMicrophone();
      const ctx=ctxRef.current||createBrowserAudioContext();
      if(!ctx){stream.getTracks().forEach(t=>t.stop());setStatus('Web Audio unavailable');return}
      ctxRef.current=ctx;await resumeBrowserAudio(ctx);
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();
      analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;analyser.minDecibels=-100;analyser.maxDecibels=-10;
      source.connect(analyser);
      streamRef.current=stream;sourceRef.current=source;analyserRef.current=analyser;
      trackerRef.current.reset();needleFilterRef.current.reset();
      setRunning(true);clearPitch(false);setMicLevel(0);
      setStatus('Listening · harmonic-aware tracking ready');lastRef.current=0;
      rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }

  function stop(){
    if(nativeActiveRef.current||nativeListenerRef.current||nativeErrorListenerRef.current){
      nativeActiveRef.current=false;
      const listener=nativeListenerRef.current;nativeListenerRef.current=null;
      const errorListener=nativeErrorListenerRef.current;nativeErrorListenerRef.current=null;
      if(listener)void listener.remove();
      if(errorListener)void errorListener.remove();
      void NativePitch.stop().catch(()=>{});
      setRunning(false);setMicLevel(0);clearPitch(true);setStatus('Microphone stopped');return;
    }
    cancelAnimationFrame(rafRef.current);rafRef.current=0;
    try{sourceRef.current?.disconnect();analyserRef.current?.disconnect()}catch{}
    streamRef.current?.getTracks().forEach(t=>t.stop());
    sourceRef.current=null;analyserRef.current=null;streamRef.current=null;
    setRunning(false);setMicLevel(0);clearPitch(true);setStatus('Microphone stopped');
  }

  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop());if(nativeListenerRef.current)void nativeListenerRef.current.remove();if(nativeErrorListenerRef.current)void nativeErrorListenerRef.current.remove();if(nativeActiveRef.current)void NativePitch.stop().catch(()=>{});stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,needleCents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  return <>
    <div className="page-head"><div><p className="eyebrow">Universal live pitch</p><h1>Sound Tuner</h1><p>Harmonic-aware real-time pitch detection with confidence gating, dropout hold and adaptive needle smoothing for stable instrument tuning.</p></div><div className="badge">Detect → validate → track</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap jelly-gauge">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?'Play a steady tone':inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row"><span className="target-chip">20–5000 Hz</span><span className="target-chip">Harmonic validated</span></div>
        </main>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Reference A4</span><span>{a4.toFixed(1)} Hz</span></div><input className="range" type="range" min="415" max="466" step=".1" value={a4} onChange={e=>setA4(+e.target.value)}/><div className="seg three"><button onClick={()=>setA4(415)} className={a4===415?'active':''}>415</button><button onClick={()=>setA4(440)} className={a4===440?'active':''}>440</button><button onClick={()=>setA4(442)} className={a4===442?'active':''}>442</button></div></div>
          <div className="control"><div className="control-label"><span>Optional reference tones</span></div><div className="seg four">{OPEN_STRINGS.map((midi,i)=><button key={midi} className={activeRef===midi?'active':''} onClick={()=>activeRef===midi?stopReference():playReference(midi)}>{OPEN_LABELS[i]}</button>)}</div><label className="toggle" style={{marginTop:9}}><span>Loop reference</span><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);if(audioRef.current)audioRef.current.loop=e.target.checked}}/></label></div>
          <div className="control"><div className="status">{status}</div></div>
          <button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start tuning'}</button>
        </aside>
      </div>
    </section>
  </>;
}
