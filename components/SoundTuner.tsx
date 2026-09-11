'use client';

import { useEffect, useRef, useState } from 'react';
import { OPEN_STRINGS, median, midiFrequency, noteFromFrequencyRange, rms } from '@/lib/music';
import { detectPitch } from '@/lib/yin';

const OPEN_LABELS=['G3','D4','A4','E5'];
const BUFFER_SIZE=8192;
const ANALYSIS_MS=40;
const RMS_MIN=.00045;
const MIN_CANDIDATE_CLARITY=.26;
const ACCEPT_CLARITY=.42;
const STRONG_CLARITY=.76;
const NOISE_MARGIN=2.15;
const CLEAR_AFTER_MISSES=12;
const CENTS_DEADBAND=.25;

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

  const ctxRef=useRef<AudioContext|null>(null),analyserRef=useRef<AnalyserNode|null>(null),sourceRef=useRef<MediaStreamAudioSourceNode|null>(null),highPassRef=useRef<BiquadFilterNode|null>(null),lowPassRef=useRef<BiquadFilterNode|null>(null),streamRef=useRef<MediaStream|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE)),cleanRef=useRef(new Float32Array(BUFFER_SIZE));
  const rafRef=useRef(0),lastRef=useRef(0),missRef=useRef(0),historyRef=useRef<number[]>([]),pendingMidiRef=useRef<number|null>(null),pendingCountRef=useRef(0),lockedMidiRef=useRef<number|null>(null),lastStatusRef=useRef('');
  const noiseFloorRef=useRef(.00032),smoothedCentsRef=useRef(0),hasCentsSmoothRef=useRef(false),smoothedFrequencyRef=useRef<number|null>(null);
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  function cleanFrame(input:Float32Array,out:Float32Array){
    let mean=0;for(let i=0;i<input.length;i++)mean+=input[i];mean/=input.length;
    for(let i=0;i<input.length;i++)out[i]=input[i]-mean;
  }
  function updateNoiseFloor(volume:number){
    const old=noiseFloorRef.current;
    // Only learn genuine quiet-room input. A soft bass/guitar/piano note must
    // not slowly become the new "noise floor" while it is sustaining.
    const learnBelow=Math.max(.0038,old*1.8);
    if(volume<learnBelow){
      const alpha=volume<old*1.6?.055:.006;
      noiseFloorRef.current=Math.max(.00012,Math.min(.004,old*(1-alpha)+volume*alpha));
    }
    return Math.max(RMS_MIN,noiseFloorRef.current*NOISE_MARGIN);
  }
  function smoothFrequency(raw:number,quality:number){
    historyRef.current.push(raw);if(historyRef.current.length>7)historyRef.current.shift();
    const logs=historyRef.current.map(v=>Math.log2(v));
    const robust=Math.pow(2,median(logs));
    if(smoothedFrequencyRef.current===null){smoothedFrequencyRef.current=robust;return robust}
    const current=smoothedFrequencyRef.current,delta=1200*Math.log2(robust/current);
    const alpha=Math.abs(delta)>35?.58:quality>=.85?.36:.24;
    const next=current*Math.pow(2,delta*alpha/1200);smoothedFrequencyRef.current=next;return next;
  }
  function smoothCents(raw:number){
    if(!hasCentsSmoothRef.current){smoothedCentsRef.current=raw;hasCentsSmoothRef.current=true;return raw}
    const delta=raw-smoothedCentsRef.current;
    if(Math.abs(delta)<CENTS_DEADBAND)return smoothedCentsRef.current;
    const alpha=Math.abs(delta)>12?.44:Math.abs(delta)>5?.30:.20;
    smoothedCentsRef.current+=delta*alpha;return smoothedCentsRef.current;
  }
  function resetPitchSmoothing(){historyRef.current=[];smoothedFrequencyRef.current=null;hasCentsSmoothRef.current=false}
  function clearPitch(){setNote('—');setFrequency(null);setCents(null);setClarity(0);pendingMidiRef.current=null;pendingCountRef.current=0;lockedMidiRef.current=null;resetPitchSmoothing()}
  function resetReading(){clearPitch();setMicLevel(0);missRef.current=0;noiseFloorRef.current=.00032}
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
    const immediate=noteFromFrequencyRange(raw,a4);if(!immediate)return;
    const candidate=immediate.midi,current=lockedMidiRef.current;

    if(current===null||current!==candidate){
      if(pendingMidiRef.current===candidate)pendingCountRef.current++;else{pendingMidiRef.current=candidate;pendingCountRef.current=1}
      let required=current===null?(quality>=STRONG_CLARITY?2:quality>=ACCEPT_CLARITY?3:4):3;
      if(current!==null){
        const jump=Math.abs(candidate-current),octaveJump=jump>=12&&jump%12===0;
        if(octaveJump)required=4;else if(jump>=7)required=3;
        if(quality>=.90)required=Math.max(2,required-1);
      }
      if(pendingCountRef.current<required){setLiveStatus(`Checking full-range pitch · ${immediate.label}`);return}
      lockedMidiRef.current=candidate;pendingMidiRef.current=null;pendingCountRef.current=0;resetPitchSmoothing();
    }else{
      pendingMidiRef.current=null;pendingCountRef.current=0;
    }

    const stable=smoothFrequency(raw,quality),mapped=noteFromFrequencyRange(stable,a4);if(!mapped)return;
    if(lockedMidiRef.current!==mapped.midi){setLiveStatus(`Holding ${note} · verifying ${immediate.label}`);return}
    const softCents=smoothCents(mapped.cents);
    setNote(mapped.label);setFrequency(stable);setCents(softCents);setClarity(quality);missRef.current=0;setLiveStatus(`Full-range pitch locked · ${mapped.label}`);
  }

  function analyse(ts:number){
    const analyser=analyserRef.current,ctx=ctxRef.current;if(!analyser||!ctx)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;const input=bufferRef.current,clean=cleanRef.current;analyser.getFloatTimeDomainData(input);cleanFrame(input,clean);
      const volume=rms(clean),level=levelPercent(volume),gate=updateNoiseFloor(volume);setMicLevel(level);
      if(volume>=gate){
        const minHz=midiFrequency(23.5,a4),maxHz=midiFrequency(103.5,a4),result=detectPitch(clean,ctx.sampleRate,minHz,maxHz),quality=result?.clarity??0;
        setClarity(quality);
        const ranged=result?noteFromFrequencyRange(result.frequency,a4):null;
        if(result&&ranged&&quality>=MIN_CANDIDATE_CLARITY){acceptPitch(result.frequency,quality)}
        else{
          missRef.current++;setLiveStatus(result?'Pitch present · building confidence':'Sound present · scanning low/mid/high bands');
          if(missRef.current>CLEAR_AFTER_MISSES)clearPitch();
        }
      }else{
        missRef.current++;setClarity(0);setLiveStatus(level>0?'Noise filtered · play a steady note':'Listening · play a note');
        if(missRef.current>CLEAR_AFTER_MISSES)clearPitch();
      }
    }
    rafRef.current=requestAnimationFrame(analyse);
  }

  async function start(){
    if(running)return;stopReference();const AC=audioContextCtor();if(!AC||!navigator.mediaDevices?.getUserMedia){setStatus('Microphone API unavailable');return}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
      const source=ctx.createMediaStreamSource(stream),highPass=ctx.createBiquadFilter(),lowPass=ctx.createBiquadFilter(),analyser=ctx.createAnalyser();
      highPass.type='highpass';highPass.frequency.value=18;highPass.Q.value=.707;
      lowPass.type='lowpass';lowPass.frequency.value=Math.min(7500,ctx.sampleRate*.23);lowPass.Q.value=.5;
      analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;
      source.connect(highPass).connect(lowPass).connect(analyser);
      streamRef.current=stream;sourceRef.current=source;highPassRef.current=highPass;lowPassRef.current=lowPass;analyserRef.current=analyser;
      setRunning(true);resetReading();lastStatusRef.current='';setLiveStatus('Listening · full C1–G7 multi-range tracking active');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }
  function stop(){
    cancelAnimationFrame(rafRef.current);rafRef.current=0;
    try{sourceRef.current?.disconnect();highPassRef.current?.disconnect();lowPassRef.current?.disconnect()}catch{}
    streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;highPassRef.current=null;lowPassRef.current=null;streamRef.current=null;analyserRef.current=null;
    setRunning(false);resetReading();lastStatusRef.current='';setStatus('Microphone stopped');
  }
  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop());stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  const activeRange=frequency?noteFromFrequencyRange(frequency,a4):null;
  const activePitchClass=activeRange?activeRange.midi%12:null;

  return <>
    <div className="page-head"><div><p className="eyebrow">Universal full-range tuner</p><h1>Sound Tuner</h1><p>Guitar, violin, piano, bass, winds, voice and other steady sounds are analysed across low, mid and high pitch bands and mapped by exact C1–G7 note ranges.</p></div><div className="badge">Mic → multi-range pitch → note → cents</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}% · Confidence ${Math.round(clarity*100)}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap jelly-gauge">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?(micLevel>2?'Sound detected · scanning full pitch range':'Play a clear steady tone'):inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row">{OPEN_STRINGS.map((midi,i)=><span className={`target-chip ${activePitchClass===midi%12?'active':''}`} key={midi}>{OPEN_LABELS[i]} · {midiFrequency(midi,a4).toFixed(1)} Hz</span>)}</div>
        </main>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Reference A4</span><span>{a4.toFixed(1)} Hz</span></div><input className="range" type="range" min="415" max="466" step=".1" value={a4} onChange={e=>{setA4(+e.target.value);historyRef.current=[];lockedMidiRef.current=null;pendingMidiRef.current=null;pendingCountRef.current=0;smoothedFrequencyRef.current=null;hasCentsSmoothRef.current=false}}/><div className="seg three"><button onClick={()=>{setA4(415);resetPitchSmoothing();lockedMidiRef.current=null}} className={a4===415?'active':''}>415</button><button onClick={()=>{setA4(440);resetPitchSmoothing();lockedMidiRef.current=null}} className={a4===440?'active':''}>440</button><button onClick={()=>{setA4(442);resetPitchSmoothing();lockedMidiRef.current=null}} className={a4===442?'active':''}>442</button></div></div>
          <div className="control"><div className="control-label"><span>Quick reference tones</span></div><div className="seg four">{OPEN_STRINGS.map((midi,i)=><button key={midi} className={activeRef===midi?'active':''} onClick={()=>activeRef===midi?stopReference():playReference(midi)}>{OPEN_LABELS[i]}</button>)}</div><label className="toggle" style={{marginTop:9}}><span>Loop reference</span><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);if(audioRef.current)audioRef.current.loop=e.target.checked}}/></label></div>
          <div className="control"><div className="status">{status}</div></div>
          <button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start tuning'}</button>
        </aside>
      </div>
    </section>
  </>;
}
