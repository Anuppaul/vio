'use client';

import { useEffect, useRef, useState } from 'react';
import { PitchDetector } from 'pitchy';
import { rms } from '@/lib/music';
import { createBrowserAudioContext, requestRawMicrophone, resumeBrowserAudio } from '@/lib/browser-audio';

const BUFFER_SIZE=8192;
const ANALYSIS_MS=35;
const SA_READY_FRAMES=7;
const SA_READY_MIN_INLIERS=5;
const SA_READY_TOLERANCE_CENTS=12;
const SA_VOICE_SECONDS=.7;
const SA_CAPTURE_MAX_SECONDS=1.15;
const BASE_SWARAS=['সা','ঋ','র','জ্ঞ','গ','ম','ক্ষ','প','দ','ধ','ণ','ন'];
const SAPTAK_OFFSETS={
  mandra:Array.from({length:12},(_,i)=>i-12),
  madhya:Array.from({length:12},(_,i)=>i),
  taar:Array.from({length:12},(_,i)=>i+12)
};

type Saptak='mandra'|'madhya'|'taar';
type RelativePitch={offset:number;degree:number;saptak:Saptak;label:string;target:number;cents:number};

function mod(n:number,m:number){return((n%m)+m)%m}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}
function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return[cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const[x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return`M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function swaraLabel(degree:number,saptak:Saptak){const base=BASE_SWARAS[degree];return saptak==='taar'?`র্${base}`:base}
function saptakName(saptak:Saptak){return saptak==='mandra'?'মন্দ্র সপ্তক':saptak==='taar'?'তার সপ্তক':'মধ্য সপ্তক'}
function stablePitch(values:number[]){
  if(values.length<SA_READY_FRAMES)return null;
  const logs=values.map(v=>Math.log2(v)).sort((a,b)=>a-b),mid=Math.floor(logs.length/2),median=logs.length%2?logs[mid]:(logs[mid-1]+logs[mid])/2;
  const reference=Math.pow(2,median);
  const inliers=values.filter(v=>Math.abs(1200*Math.log2(v/reference))<=SA_READY_TOLERANCE_CENTS).length;
  return inliers>=SA_READY_MIN_INLIERS?reference:null;
}
function relativePitch(frequency:number,sa:number):RelativePitch|null{
  if(!(frequency>0)||!(sa>0))return null;
  const exact=12*Math.log2(frequency/sa),offset=Math.round(exact);
  if(offset<-12||offset>23)return null;
  const degree=mod(offset,12),saptak:Saptak=offset<0?'mandra':offset>=12?'taar':'madhya';
  const target=sa*Math.pow(2,offset/12),cents=1200*Math.log2(frequency/target);
  return{offset,degree,saptak,label:swaraLabel(degree,saptak),target,cents};
}

export default function ScalePractice(){
  const[running,setRunning]=useState(false);
  const[frequency,setFrequency]=useState<number|null>(null);
  const[saFrequency,setSaFrequency]=useState<number|null>(null);
  const[saReadyFrequency,setSaReadyFrequency]=useState<number|null>(null);
  const[micLevel,setMicLevel]=useState(0);
  const[status,setStatus]=useState('Start the microphone, sing Sa, then set it as your reference.');
  const[hasSaVoice,setHasSaVoice]=useState(false);
  const[playingOffset,setPlayingOffset]=useState<number|null>(null);

  const ctxRef=useRef<AudioContext|null>(null),analyserRef=useRef<AnalyserNode|null>(null),sourceRef=useRef<MediaStreamAudioSourceNode|null>(null),streamRef=useRef<MediaStream|null>(null);
  const processorRef=useRef<ScriptProcessorNode|null>(null),workletRef=useRef<AudioWorkletNode|null>(null),silentGainRef=useRef<GainNode|null>(null),playbackSourceRef=useRef<AudioBufferSourceNode|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE)),rafRef=useRef(0),lastRef=useRef(0),saFrequencyRef=useRef<number|null>(null),saSamplesRef=useRef<number[]>([]);
  const captureChunksRef=useRef<Float32Array[]>([]),captureSamplesRef=useRef(0),candidateVoiceRef=useRef<Float32Array|null>(null),saVoiceRef=useRef<Float32Array|null>(null),saVoiceRateRef=useRef(0);
  const detectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null),workletLoadedRef=useRef(false);

  if(!detectorRef.current){const detector=PitchDetector.forFloat32Array(BUFFER_SIZE);detector.minVolumeAbsolute=0;detectorRef.current=detector}
  useEffect(()=>{saFrequencyRef.current=saFrequency},[saFrequency]);

  const current=frequency&&saFrequency?relativePitch(frequency,saFrequency):null;
  const cents=current?.cents??null;
  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=5;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';

  function clearCapture(){captureChunksRef.current=[];captureSamplesRef.current=0;candidateVoiceRef.current=null}
  function appendCapture(input:Float32Array<ArrayBufferLike>,sampleRate:number){
    const copy=new Float32Array(input.length);copy.set(input);captureChunksRef.current.push(copy);captureSamplesRef.current+=copy.length;
    const maxSamples=Math.ceil(sampleRate*SA_CAPTURE_MAX_SECONDS);
    while(captureSamplesRef.current>maxSamples&&captureChunksRef.current.length>1){const first=captureChunksRef.current.shift();if(first)captureSamplesRef.current-=first.length}
  }
  function recentVoiceSample(sampleRate:number,seconds=SA_VOICE_SECONDS){
    const wanted=Math.min(captureSamplesRef.current,Math.floor(sampleRate*seconds));if(wanted<Math.floor(sampleRate*.2))return null;
    const out=new Float32Array(wanted);let write=wanted;
    for(let i=captureChunksRef.current.length-1;i>=0&&write>0;i--){const chunk=captureChunksRef.current[i],take=Math.min(write,chunk.length);write-=take;out.set(chunk.subarray(chunk.length-take),write)}
    let mean=0,peak=0;for(let i=0;i<out.length;i++)mean+=out[i];mean/=out.length;
    for(let i=0;i<out.length;i++){out[i]-=mean;peak=Math.max(peak,Math.abs(out[i]))}
    if(peak<.002)return null;
    return out;
  }
  function stopReference(){try{playbackSourceRef.current?.stop()}catch{}playbackSourceRef.current=null;setPlayingOffset(null)}
  function clearSaReadiness(){saSamplesRef.current=[];setSaReadyFrequency(null);candidateVoiceRef.current=null}
  function clearLive(){setFrequency(null);setMicLevel(0);clearSaReadiness()}
  function analyse(ts:number){
    const analyser=analyserRef.current,ctx=ctxRef.current,detector=detectorRef.current;if(!analyser||!ctx||!detector)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;const input=bufferRef.current;analyser.getFloatTimeDomainData(input);setMicLevel(levelPercent(rms(input)));
      const[rawFrequency]=detector.findPitch(input,ctx.sampleRate);
      if(rawFrequency>0&&Number.isFinite(rawFrequency)){
        setFrequency(rawFrequency);
        if(saFrequencyRef.current){clearSaReadiness();setStatus('Practice live · sing any swara')}
        else{
          const samples=saSamplesRef.current;samples.push(rawFrequency);if(samples.length>SA_READY_FRAMES)samples.shift();
          const ready=stablePitch(samples);setSaReadyFrequency(ready);
          if(ready){const voice=recentVoiceSample(ctx.sampleRate);if(voice)candidateVoiceRef.current=voice}
          setStatus(ready?'Sa detected · ready to set':'Hold Sa steady · 5 of 7 samples must stay within ±12 cents');
        }
      }else{
        setFrequency(null);clearSaReadiness();setStatus('Listening · no pitch detected');
      }
    }
    rafRef.current=requestAnimationFrame(analyse);
  }
  async function start(){
    if(running)return;
    try{
      const stream=await requestRawMicrophone();
      const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx){stream.getTracks().forEach(t=>t.stop());setStatus('Web Audio unavailable');return}ctxRef.current=ctx;await resumeBrowserAudio(ctx);
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser(),silent=ctx.createGain();
      let processor:ScriptProcessorNode|null=null,worklet:AudioWorkletNode|null=null;
      analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;silent.gain.value=0;clearCapture();
      source.connect(analyser);
      if(ctx.audioWorklet&&typeof AudioWorkletNode!=='undefined'){
        try{
          if(!workletLoadedRef.current){await ctx.audioWorklet.addModule('/audio-worklets/vio-capture.js');workletLoadedRef.current=true}
          worklet=new AudioWorkletNode(ctx,'vio-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
          worklet.port.onmessage=e=>{if(e.data instanceof Float32Array)appendCapture(e.data,ctx.sampleRate)};
          source.connect(worklet);worklet.connect(silent);
        }catch{worklet=null}
      }
      if(!worklet){
        processor=ctx.createScriptProcessor(2048,1,1);
        processor.onaudioprocess=e=>appendCapture(e.inputBuffer.getChannelData(0),ctx.sampleRate);
        source.connect(processor);processor.connect(silent);
      }
      silent.connect(ctx.destination);
      streamRef.current=stream;sourceRef.current=source;analyserRef.current=analyser;processorRef.current=processor;workletRef.current=worklet;silentGainRef.current=silent;setRunning(true);clearLive();setStatus(saFrequencyRef.current?'Practice live · sing any swara':'Sing and hold your Sa; natural variation up to ±12 cents is allowed.');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }
  function stop(){
    cancelAnimationFrame(rafRef.current);rafRef.current=0;try{sourceRef.current?.disconnect();analyserRef.current?.disconnect();if(processorRef.current)processorRef.current.onaudioprocess=null;processorRef.current?.disconnect();if(workletRef.current)workletRef.current.port.onmessage=null;workletRef.current?.disconnect();silentGainRef.current?.disconnect()}catch{}
    streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;analyserRef.current=null;processorRef.current=null;workletRef.current=null;silentGainRef.current=null;streamRef.current=null;setRunning(false);clearLive();clearCapture();setStatus('Microphone stopped')
  }
  function setSa(){
    const chosen=saFrequency?frequency:saReadyFrequency;if(!chosen)return;const ctx=ctxRef.current;
    const voice=(saFrequency&&ctx?recentVoiceSample(ctx.sampleRate):candidateVoiceRef.current)||(ctx?recentVoiceSample(ctx.sampleRate):null);
    if(voice&&ctx){saVoiceRef.current=voice;saVoiceRateRef.current=ctx.sampleRate;setHasSaVoice(true)}else{saVoiceRef.current=null;saVoiceRateRef.current=0;setHasSaVoice(false)}
    stopReference();saFrequencyRef.current=chosen;setSaFrequency(chosen);clearSaReadiness();setStatus(`Sa set at ${chosen.toFixed(2)} Hz${voice?' · voice reference saved · tap any swara to hear it':' · tap any swara to hear a reference tone'}`)
  }
  function resetSa(){stopReference();saFrequencyRef.current=null;setSaFrequency(null);saVoiceRef.current=null;saVoiceRateRef.current=0;setHasSaVoice(false);clearSaReadiness();setStatus('Sa cleared · sing and hold Sa; natural variation up to ±12 cents is allowed')}
  async function playSwara(offset:number,kind:Saptak){
    if(!saFrequency)return;const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx)return;ctxRef.current=ctx;await resumeBrowserAudio(ctx);stopReference();
    const target=saFrequency*Math.pow(2,offset/12),label=swaraLabel(mod(offset,12),kind),voice=saVoiceRef.current,voiceRate=saVoiceRateRef.current;
    setPlayingOffset(offset);setStatus(`Reference · ${label} · ${target.toFixed(2)} Hz${voice?' · your Sa voice':' · clean tone'}`);
    if(voice&&voiceRate>0){
      const audioBuffer=ctx.createBuffer(1,voice.length,voiceRate),channel=audioBuffer.getChannelData(0);for(let i=0;i<voice.length;i++)channel[i]=voice[i];const source=ctx.createBufferSource(),gain=ctx.createGain(),rate=Math.pow(2,offset/12),duration=audioBuffer.duration/rate,fade=Math.min(.025,duration*.12),now=ctx.currentTime;
      source.buffer=audioBuffer;source.playbackRate.value=rate;gain.gain.setValueAtTime(.0001,now);gain.gain.linearRampToValueAtTime(.82,now+fade);gain.gain.setValueAtTime(.82,Math.max(now+fade,now+duration-fade));gain.gain.linearRampToValueAtTime(.0001,now+duration);source.connect(gain).connect(ctx.destination);playbackSourceRef.current=source;source.onended=()=>{if(playbackSourceRef.current===source){playbackSourceRef.current=null;setPlayingOffset(null)}};source.start();return;
    }
    const osc=ctx.createOscillator(),gain=ctx.createGain(),now=ctx.currentTime,duration=.65;osc.type='triangle';osc.frequency.value=target;gain.gain.setValueAtTime(.0001,now);gain.gain.linearRampToValueAtTime(.16,now+.025);gain.gain.setValueAtTime(.16,now+duration-.05);gain.gain.exponentialRampToValueAtTime(.0001,now+duration);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(now+duration);osc.onended=()=>setPlayingOffset(null)
  }
  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);stopReference();try{if(processorRef.current)processorRef.current.onaudioprocess=null;processorRef.current?.disconnect();if(workletRef.current)workletRef.current.port.onmessage=null;workletRef.current?.disconnect();silentGainRef.current?.disconnect()}catch{}streamRef.current?.getTracks().forEach(t=>t.stop())},[]);

  function scaleRow(kind:Saptak,offsets:number[]){
    return <div className={`saptak-card ${kind}`}><div className="saptak-title"><b>{saptakName(kind)}</b><span>{saFrequency?'Tap any swara to hear reference':kind==='mandra'?'Underline = Mandra':kind==='taar'?'র্ prefix = Taar':'Your Sa starts here'}</span></div><div className="swara-grid">{offsets.map(offset=>{const degree=mod(offset,12),label=swaraLabel(degree,kind),target=saFrequency?saFrequency*Math.pow(2,offset/12):null,active=current?.offset===offset,playing=playingOffset===offset;return <button type="button" key={offset} className={`swara-cell ${active?'active':''} ${playing?'reference-playing':''}`} disabled={!saFrequency} onClick={()=>void playSwara(offset,kind)} aria-label={target?`Play ${label} reference at ${target.toFixed(1)} hertz`:`${label}, set Sa first`}><b className={kind==='mandra'?'mandra-mark':''}>{label}</b><small>{target?`${playing?'♪ ':''}${target.toFixed(1)} Hz`:'—'}</small></button>})}</div></div>;
  }

  const saReady=!saFrequency&&saReadyFrequency!==null;
  const canSetSa=saFrequency?frequency!==null:saReady;

  return <>
    <div className="page-head"><div><p className="eyebrow">Indian classical ear training</p><h1>Scale Practice</h1><p>Sing your own Sa first. That exact pitch becomes the tonic, and the full Mandra, Madhya and Taar saptak are generated relative to it.</p></div><div className="badge">Your Sa → relative swara → cents</div></div>
    <section className="card scale-practice-card">
      <div className="card-head"><div><h2>Relative Sa tuner</h2><span>{saFrequency?`Sa · ${saFrequency.toFixed(2)} Hz${hasSaVoice?' · voice saved':''}`:'Sa not set yet'}</span></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="scale-practice-layout">
        <main className="scale-practice-main">
          <div className="control-label"><span>Raw microphone input</span><span>{running?`${micLevel}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="scale-gauge-wrap">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Swara pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-7,7)}/>{current&&<><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></>}</svg>
            <div className="scale-readout">{!saFrequency?<><div className="scale-prompt">সা</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'Sing your Sa'}</div>{saReady?<div className="sa-ready"><i/>Sa detected · ready to set</div>:<div className="hint">Hold Sa steadily; 5 of 7 samples may vary within ±12 cents</div>}</>:current?<><div className={`scale-swara ${current.saptak==='mandra'?'mandra-mark':''}`} style={{color}}>{current.label}</div><div className="scale-saptak-name">{saptakName(current.saptak)}</div><div className="frequency">Actual {frequency?.toFixed(2)} Hz · Target {current.target.toFixed(2)} Hz · {current.cents>=0?'+':''}{current.cents.toFixed(1)} cents</div><div className="hint">{inTune?'সঠিক সুর':current.cents<0?`${Math.abs(current.cents).toFixed(1)} cents নিচে`:`${current.cents.toFixed(1)} cents উপরে`}</div></>:<><div className="scale-prompt">—</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'}</div><div className="hint">Outside Mandra–Madhya–Taar practice range</div></>}</div>
          </div>
          {saFrequency&&<div className="swara-play-hint">♪ Tap any swara below to hear {hasSaVoice?'your recorded Sa voice pitch-shifted to that swara':'its reference pitch'}</div>}
          <div className="saptak-stack">{scaleRow('mandra',SAPTAK_OFFSETS.mandra)}{scaleRow('madhya',SAPTAK_OFFSETS.madhya)}{scaleRow('taar',SAPTAK_OFFSETS.taar)}</div>
        </main>
        <aside className="side scale-practice-side">
          <div className="control"><div className="control-label"><span>Step 1 · Microphone</span></div><button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start microphone'}</button></div>
          <div className="control"><div className="control-label"><span>Step 2 · Set your Sa</span><span>{saReady?`${saReadyFrequency?.toFixed(2)} Hz`:frequency?`${frequency.toFixed(2)} Hz`:'No pitch'}</span></div>{!saFrequency&&<div className={`sa-ready-row ${saReady?'ready':''}`}><i/><span>{saReady?'Sa detected · ready to set':'Hold Sa steady · ±12 cents allowed'}</span></div>}<button className={`primary ${saReady?'sa-ready-button':''}`} disabled={!canSetSa} onClick={setSa}>{saFrequency?'Set current pitch as new Sa':'Set current pitch as Sa'}</button>{saFrequency&&<button className="soft-btn scale-reset" onClick={resetSa}>Clear Sa</button>}</div>
          <div className="control"><div className="control-label"><span>Your tonic</span></div><div className="sa-reference"><b>{saFrequency?'সা':'—'}</b><span>{saFrequency?`${saFrequency.toFixed(2)} Hz${hasSaVoice?' · recorded voice ready':''}`:'Sing Sa first'}</span></div></div>
          <div className="control"><div className="status">{status}</div></div>
        </aside>
      </div>
    </section>
  </>;
}
