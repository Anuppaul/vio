'use client';

import { useEffect, useRef, useState } from 'react';
import { PitchDetector } from 'pitchy';
import { rms } from '@/lib/music';

const BUFFER_SIZE=8192;
const ANALYSIS_MS=35;
const SA_READY_FRAMES=7;
const SA_READY_MIN_INLIERS=5;
const SA_READY_TOLERANCE_CENTS=12;
const BASE_SWARAS=['সা','ঋ','র','জ্ঞ','গ','ম','ক্ষ','প','দ','ধ','ণ','ন'];
const SAPTAK_OFFSETS={
  mandra:Array.from({length:12},(_,i)=>i-12),
  madhya:Array.from({length:12},(_,i)=>i),
  taar:Array.from({length:12},(_,i)=>i+12)
};

type Saptak='mandra'|'madhya'|'taar';
type RelativePitch={offset:number;degree:number;saptak:Saptak;label:string;target:number;cents:number};

function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
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

  const ctxRef=useRef<AudioContext|null>(null),analyserRef=useRef<AnalyserNode|null>(null),sourceRef=useRef<MediaStreamAudioSourceNode|null>(null),streamRef=useRef<MediaStream|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE)),rafRef=useRef(0),lastRef=useRef(0),saFrequencyRef=useRef<number|null>(null),saSamplesRef=useRef<number[]>([]);
  const detectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);

  if(!detectorRef.current){const detector=PitchDetector.forFloat32Array(BUFFER_SIZE);detector.minVolumeAbsolute=0;detectorRef.current=detector}
  useEffect(()=>{saFrequencyRef.current=saFrequency},[saFrequency]);

  const current=frequency&&saFrequency?relativePitch(frequency,saFrequency):null;
  const cents=current?.cents??null;
  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=5;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';

  function clearSaReadiness(){saSamplesRef.current=[];setSaReadyFrequency(null)}
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
          setStatus(ready?'Sa detected · ready to set':'Hold Sa steady · 5 of 7 samples must stay within ±12 cents');
        }
      }else{
        setFrequency(null);clearSaReadiness();setStatus('Listening · no pitch detected');
      }
    }
    rafRef.current=requestAnimationFrame(analyse);
  }
  async function start(){
    if(running)return;const AC=audioContextCtor();if(!AC||!navigator.mediaDevices?.getUserMedia){setStatus('Microphone API unavailable');return}
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();analyser.fftSize=BUFFER_SIZE;analyser.smoothingTimeConstant=0;source.connect(analyser);
      streamRef.current=stream;sourceRef.current=source;analyserRef.current=analyser;setRunning(true);clearLive();setStatus(saFrequencyRef.current?'Practice live · sing any swara':'Sing and hold your Sa; natural variation up to ±12 cents is allowed.');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse);
    }catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}
  }
  function stop(){cancelAnimationFrame(rafRef.current);rafRef.current=0;try{sourceRef.current?.disconnect();analyserRef.current?.disconnect()}catch{}streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;analyserRef.current=null;streamRef.current=null;setRunning(false);clearLive();setStatus('Microphone stopped')}
  function setSa(){const chosen=saFrequency?frequency:saReadyFrequency;if(!chosen)return;saFrequencyRef.current=chosen;setSaFrequency(chosen);clearSaReadiness();setStatus(`Sa set at ${chosen.toFixed(2)} Hz · now sing through the scale`)}
  function resetSa(){saFrequencyRef.current=null;setSaFrequency(null);clearSaReadiness();setStatus('Sa cleared · sing and hold Sa; natural variation up to ±12 cents is allowed')}
  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop())},[]);

  function scaleRow(kind:Saptak,offsets:number[]){
    return <div className={`saptak-card ${kind}`}><div className="saptak-title"><b>{saptakName(kind)}</b><span>{kind==='mandra'?'Underline = Mandra':kind==='taar'?'র্ prefix = Taar':'Your Sa starts here'}</span></div><div className="swara-grid">{offsets.map(offset=>{const degree=mod(offset,12),label=swaraLabel(degree,kind),target=saFrequency?saFrequency*Math.pow(2,offset/12):null,active=current?.offset===offset;return <div key={offset} className={`swara-cell ${active?'active':''}`}><b className={kind==='mandra'?'mandra-mark':''}>{label}</b><small>{target?`${target.toFixed(1)} Hz`:'—'}</small></div>})}</div></div>;
  }

  const saReady=!saFrequency&&saReadyFrequency!==null;
  const canSetSa=saFrequency?frequency!==null:saReady;

  return <>
    <div className="page-head"><div><p className="eyebrow">Indian classical ear training</p><h1>Scale Practice</h1><p>Sing your own Sa first. That exact pitch becomes the tonic, and the full Mandra, Madhya and Taar saptak are generated relative to it.</p></div><div className="badge">Your Sa → relative swara → cents</div></div>
    <section className="card scale-practice-card">
      <div className="card-head"><div><h2>Relative Sa tuner</h2><span>{saFrequency?`Sa · ${saFrequency.toFixed(2)} Hz`:'Sa not set yet'}</span></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="scale-practice-layout">
        <main className="scale-practice-main">
          <div className="control-label"><span>Raw microphone input</span><span>{running?`${micLevel}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="scale-gauge-wrap">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Swara pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-7,7)}/>{current&&<><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></>}</svg>
            <div className="scale-readout">{!saFrequency?<><div className="scale-prompt">সা</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'Sing your Sa'}</div>{saReady?<div className="sa-ready"><i/>Sa detected · ready to set</div>:<div className="hint">Hold Sa steadily; 5 of 7 samples may vary within ±12 cents</div>}</>:current?<><div className={`scale-swara ${current.saptak==='mandra'?'mandra-mark':''}`} style={{color}}>{current.label}</div><div className="scale-saptak-name">{saptakName(current.saptak)}</div><div className="frequency">Actual {frequency?.toFixed(2)} Hz · Target {current.target.toFixed(2)} Hz · {current.cents>=0?'+':''}{current.cents.toFixed(1)} cents</div><div className="hint">{inTune?'সঠিক সুর':current.cents<0?`${Math.abs(current.cents).toFixed(1)} cents নিচে`:`${current.cents.toFixed(1)} cents উপরে`}</div></>:<><div className="scale-prompt">—</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'}</div><div className="hint">Outside Mandra–Madhya–Taar practice range</div></>}</div>
          </div>
          <div className="saptak-stack">{scaleRow('mandra',SAPTAK_OFFSETS.mandra)}{scaleRow('madhya',SAPTAK_OFFSETS.madhya)}{scaleRow('taar',SAPTAK_OFFSETS.taar)}</div>
        </main>
        <aside className="side scale-practice-side">
          <div className="control"><div className="control-label"><span>Step 1 · Microphone</span></div><button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop microphone':'Start microphone'}</button></div>
          <div className="control"><div className="control-label"><span>Step 2 · Set your Sa</span><span>{saReady?`${saReadyFrequency?.toFixed(2)} Hz`:frequency?`${frequency.toFixed(2)} Hz`:'No pitch'}</span></div>{!saFrequency&&<div className={`sa-ready-row ${saReady?'ready':''}`}><i/><span>{saReady?'Sa detected · ready to set':'Hold Sa steady · ±12 cents allowed'}</span></div>}<button className={`primary ${saReady?'sa-ready-button':''}`} disabled={!canSetSa} onClick={setSa}>{saFrequency?'Set current pitch as new Sa':'Set current pitch as Sa'}</button>{saFrequency&&<button className="soft-btn scale-reset" onClick={resetSa}>Clear Sa</button>}</div>
          <div className="control"><div className="control-label"><span>Your tonic</span></div><div className="sa-reference"><b>{saFrequency?'সা':'—'}</b><span>{saFrequency?`${saFrequency.toFixed(2)} Hz`:'Sing Sa first'}</span></div></div>
          <div className="control"><div className="status">{status}</div></div>
        </aside>
      </div>
    </section>
  </>;
}
