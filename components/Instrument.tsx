'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';

type ScaleId='chromatic'|'major'|'minor'|'bhairav'|'kafi';
type SoundId='geo'|'violin'|'bowed'|'warm'|'glass';
type UiLanguage='bn'|'hi'|'en';

type NativeUiPlugin={
  setOrientation(options:{mode:'landscape'|'portrait'|'unspecified'}):Promise<void>;
};

const NativeUi=registerPlugin<NativeUiPlugin>('NativePitch');

type LockableScreenOrientation=ScreenOrientation&{
  lock?:(orientation:'landscape')=>Promise<void>;
};

type Voice={
  pointerId:number;
  model:'osc'|'string';
  oscA:OscillatorNode|null;
  oscB:OscillatorNode|null;
  mixA:GainNode|null;
  mixB:GainNode|null;
  filter:BiquadFilterNode;
  amp:GainNode;
  lfo:OscillatorNode|null;
  lfoDepth:GainNode|null;
  noise:AudioBufferSourceNode|null;
  noiseGain:GainNode|null;
  stringDelay:DelayNode|null;
  stringFeedback:GainNode|null;
  stringDamping:BiquadFilterNode|null;
  stringBody:BiquadFilterNode|null;
  ratio:number;
  release:number;
  noiseAmount:number;
  brightMin:number;
  brightRange:number;
  expressionMin:number;
  expressionRange:number;
  offset:number;
};

type ActiveTouch={pointerId:number;x:number;y:number;offset:number;frequency:number};

const RANGE_START=-12;
const RANGE_STEPS=36;
const C4=261.625565;

const SCALES:{id:ScaleId;label:string;degrees:number[]}[]=[
  {id:'chromatic',label:'Chromatic',degrees:[0,1,2,3,4,5,6,7,8,9,10,11]},
  {id:'major',label:'Major / Bilawal',degrees:[0,2,4,5,7,9,11]},
  {id:'minor',label:'Natural Minor',degrees:[0,2,3,5,7,8,10]},
  {id:'bhairav',label:'Bhairav',degrees:[0,1,4,5,7,8,11]},
  {id:'kafi',label:'Kafi',degrees:[0,2,3,5,7,9,10]}
];

const SWARAS:Record<UiLanguage,string[]>={
  bn:['সা','রে♭','রে','গা♭','গা','মা','মা♯','পা','ধা♭','ধা','নি♭','নি'],
  hi:['सा','रे♭','रे','गा♭','गा','म','म♯','प','ध♭','ध','नि♭','नि'],
  en:['Sa','Re♭','Re','Ga♭','Ga','Ma','Ma♯','Pa','Dha♭','Dha','Ni♭','Ni']
};

const LANGUAGES:{value:UiLanguage;label:string}[]=[
  {value:'bn',label:'বাংলা'},
  {value:'hi',label:'हिन्दी'},
  {value:'en',label:'English'}
];

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const mod=(n:number,m:number)=>((n%m)+m)%m;

function noteLabel(offset:number,language:UiLanguage){
  const rounded=Math.round(offset),base=SWARAS[language][mod(rounded,12)];
  if(rounded<0)return `${base}̣`;
  if(rounded>=12)return `${base}̇`;
  return base;
}

function nearestScaleOffset(raw:number,degrees:number[]){
  let best=Math.round(raw),distance=Infinity;
  for(let candidate=Math.floor(raw)-3;candidate<=Math.ceil(raw)+3;candidate++){
    if(!degrees.includes(mod(candidate,12)))continue;
    const d=Math.abs(candidate-raw);
    if(d<distance){distance=d;best=candidate}
  }
  return best;
}

export default function Instrument(){
  const[scale,setScale]=useState<ScaleId>('chromatic');
  const[sound,setSound]=useState<SoundId>('geo');
  const[language,setLanguage]=useState<UiLanguage>('bn');
  const[tonicHz,setTonicHz]=useState(C4);
  const[scaleLock,setScaleLock]=useState(true);
  const[vibrato,setVibrato]=useState(10);
  const[volume,setVolume]=useState(.72);
  const[status,setStatus]=useState('Touch or drag across the surface');
  const[touches,setTouches]=useState<ActiveTouch[]>([]);

  const surfaceRef=useRef<HTMLDivElement|null>(null);
  const ctxRef=useRef<AudioContext|null>(null);
  const masterRef=useRef<GainNode|null>(null);
  const limiterRef=useRef<DynamicsCompressorNode|null>(null);
  const voicesRef=useRef(new Map<number,Voice>());
  const waveCacheRef=useRef(new Map<string,PeriodicWave>());
  const noiseBufferRef=useRef<AudioBuffer|null>(null);
  const pendingPointersRef=useRef(new Set<number>());
  const liveRef=useRef({scale,scaleLock,tonicHz,vibrato,volume,sound});

  const scaleDef=useMemo(()=>SCALES.find(item=>item.id===scale)||SCALES[0],[scale]);
  const cells=useMemo(()=>Array.from({length:RANGE_STEPS},(_,i)=>RANGE_START+i),[]);

  useEffect(()=>{liveRef.current={scale,scaleLock,tonicHz,vibrato,volume,sound}},[scale,scaleLock,tonicHz,vibrato,volume,sound]);
  useEffect(()=>{
    try{
      const lang=localStorage.getItem('vio-instrument-language');
      if(lang==='bn'||lang==='hi'||lang==='en')setLanguage(lang);
    }catch{}
  },[]);

  useEffect(()=>{
    if(!Capacitor.isNativePlatform())return;
    void NativeUi.setOrientation({mode:'landscape'}).catch(()=>{});
    const restore=()=>{void NativeUi.setOrientation({mode:'unspecified'}).catch(()=>{})};
    window.addEventListener('pagehide',restore);
    return()=>{
      window.removeEventListener('pagehide',restore);
      restore();
    };
  },[]);

  useEffect(()=>()=>{
    for(const voice of voicesRef.current.values()){
      try{voice.amp.gain.cancelScheduledValues(0);voice.amp.gain.value=0;voice.oscA?.stop();voice.oscB?.stop();voice.lfo?.stop();voice.noise?.stop()}catch{}
    }
    voicesRef.current.clear();
    try{ctxRef.current?.close()}catch{}
  },[]);

  function chooseLanguage(next:UiLanguage){
    setLanguage(next);
    try{localStorage.setItem('vio-instrument-language',next)}catch{}
  }

  async function requestLandscape(){
    if(Capacitor.isNativePlatform()){
      try{
        await NativeUi.setOrientation({mode:'landscape'});
        setStatus('Landscape performance mode');
      }catch{
        setStatus('Rotate your device to landscape');
      }
      return;
    }

    const orientation=typeof screen!=='undefined'
      ?screen.orientation as LockableScreenOrientation
      :null;
    if(orientation?.lock){
      try{
        await orientation.lock('landscape');
        setStatus('Landscape performance mode');
        return;
      }catch{}
    }
    setStatus('Rotate your phone to landscape for the widest playing surface');
  }

  async function ensureAudio(){
    const ctx=ctxRef.current||createBrowserAudioContext({latencyHint:'interactive'});
    if(!ctx)throw new Error('Web Audio unavailable');
    ctxRef.current=ctx;
    await resumeBrowserAudio(ctx);
    if(!masterRef.current){
      const master=ctx.createGain(),limiter=ctx.createDynamicsCompressor();
      master.gain.value=volume;
      limiter.threshold.value=-3;
      limiter.knee.value=4;
      limiter.ratio.value=10;
      limiter.attack.value=.002;
      limiter.release.value=.08;
      master.connect(limiter).connect(ctx.destination);
      masterRef.current=master;
      limiterRef.current=limiter;
    }
    return ctx;
  }

  function preset(soundId:SoundId){
    if(soundId==='geo')return{wave:'geo' as const,a:'sawtooth' as OscillatorType,b:'triangle' as OscillatorType,mixA:0,mixB:0,ratio:1,detune:0,cutoff:7200,q:.72,attack:.004,release:.48,noise:0,brightMin:1450,brightRange:7000,expressionMin:.12,expressionRange:.34};
    if(soundId==='violin')return{wave:'violin' as const,a:'sawtooth' as OscillatorType,b:'sawtooth' as OscillatorType,mixA:.54,mixB:.33,ratio:1,detune:4.5,cutoff:5100,q:.82,attack:.04,release:.42,noise:.038,brightMin:1050,brightRange:5200,expressionMin:.085,expressionRange:.245};
    if(soundId==='glass')return{wave:null,a:'sine' as OscillatorType,b:'triangle' as OscillatorType,mixA:.66,mixB:.22,ratio:2,detune:-7,cutoff:5200,q:1.3,attack:.012,release:.22,noise:0,brightMin:1600,brightRange:6200,expressionMin:.08,expressionRange:.22};
    if(soundId==='warm')return{wave:null,a:'triangle' as OscillatorType,b:'sine' as OscillatorType,mixA:.62,mixB:.34,ratio:1,detune:-7,cutoff:2350,q:.8,attack:.028,release:.28,noise:0,brightMin:800,brightRange:3600,expressionMin:.09,expressionRange:.24};
    return{wave:null,a:'sawtooth' as OscillatorType,b:'triangle' as OscillatorType,mixA:.34,mixB:.38,ratio:1,detune:-7,cutoff:3100,q:1.05,attack:.035,release:.34,noise:.012,brightMin:950,brightRange:4500,expressionMin:.09,expressionRange:.25};
  }

  function periodicWave(ctx:AudioContext,kind:'violin'){
    const cached=waveCacheRef.current.get(kind);
    if(cached)return cached;
    const harmonics=[0,1,.86,.72,.63,.50,.42,.34,.29,.24,.20,.17,.145,.12,.10,.085,.07];
    const real=new Float32Array(harmonics.length),imag=new Float32Array(harmonics.length);
    for(let n=1;n<harmonics.length;n++)imag[n]=harmonics[n];
    const wave=ctx.createPeriodicWave(real,imag,{disableNormalization:false});
    waveCacheRef.current.set(kind,wave);
    return wave;
  }

  function bowNoise(ctx:AudioContext){
    if(noiseBufferRef.current&&noiseBufferRef.current.sampleRate===ctx.sampleRate)return noiseBufferRef.current;
    const length=Math.max(1024,Math.floor(ctx.sampleRate*.25));
    const buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
    let previous=0;
    for(let index=0;index<length;index++){
      const white=Math.random()*2-1;
      previous=previous*.72+white*.28;
      data[index]=previous*.7+white*.3;
    }
    noiseBufferRef.current=buffer;
    return buffer;
  }

  function startPhysicalString(ctx:AudioContext,master:GainNode,frequency:number,amp:GainNode,filter:BiquadFilterNode){
    const delay=ctx.createDelay(1);
    const damping=ctx.createBiquadFilter();
    const feedback=ctx.createGain();
    const body=ctx.createBiquadFilter();
    const excitation=ctx.createBufferSource();
    const excitationGain=ctx.createGain();

    delay.delayTime.value=clamp(1/Math.max(35,frequency),.0008,.045);
    damping.type='lowpass';damping.frequency.value=5600;damping.Q.value=.35;
    feedback.gain.value=.986;
    body.type='peaking';body.frequency.value=285;body.Q.value=1.15;body.gain.value=5.5;

    delay.connect(damping);
    damping.connect(feedback).connect(delay);
    damping.connect(body).connect(filter).connect(amp).connect(master);

    excitation.buffer=bowNoise(ctx);
    excitation.loop=false;
    excitationGain.gain.setValueAtTime(.82,ctx.currentTime);
    excitationGain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.038);
    excitation.connect(excitationGain).connect(delay);
    excitation.start();
    excitation.stop(ctx.currentTime+.05);

    return{delay,damping,feedback,body,excitation};
  }

  function frequencyForOffset(offset:number){
    return liveRef.current.tonicHz*Math.pow(2,offset/12);
  }

  function mapPointer(event:ReactPointerEvent<HTMLDivElement>){
    const rect=surfaceRef.current?.getBoundingClientRect();
    if(!rect)return null;
    const x=clamp((event.clientX-rect.left)/Math.max(1,rect.width),0,.999999);
    const y=clamp((event.clientY-rect.top)/Math.max(1,rect.height),0,1);
    const raw=RANGE_START+x*RANGE_STEPS;
    const def=SCALES.find(item=>item.id===liveRef.current.scale)||SCALES[0];
    let offset=raw;
    if(liveRef.current.scaleLock){
      const nearest=nearestScaleOffset(raw,def.degrees);
      offset=nearest+clamp(raw-nearest,-.32,.32);
    }
    return{x,y,offset,frequency:frequencyForOffset(offset)};
  }

  function setVoiceExpression(voice:Voice,point:{x:number;y:number;offset:number;frequency:number},immediate=false){
    const ctx=ctxRef.current;
    if(!ctx)return;
    const now=ctx.currentTime,slide=immediate ? .002 : .018;
    voice.offset=point.offset;
    if(voice.model==='string'&&voice.stringDelay){
      const delayTime=clamp(1/Math.max(35,point.frequency),.0008,.045);
      voice.stringDelay.delayTime.setTargetAtTime(delayTime,now,slide);
      if(voice.stringFeedback)voice.stringFeedback.gain.setTargetAtTime(.981+(1-point.y)*.012,now,.03);
    }else{
      voice.oscA?.frequency.setTargetAtTime(point.frequency,now,slide);
      voice.oscB?.frequency.setTargetAtTime(point.frequency*voice.ratio,now,slide);
    }
    const brightness=voice.brightMin+(1-point.y)*voice.brightRange;
    voice.filter.frequency.setTargetAtTime(brightness,now,.025);
    const expression=voice.expressionMin+(1-point.y)*voice.expressionRange;
    voice.amp.gain.setTargetAtTime(expression,now,.02);
    if(voice.noiseGain)voice.noiseGain.gain.setTargetAtTime(voice.noiseAmount*(.45+(1-point.y)*.85),now,.025);
    voice.lfoDepth?.gain.setTargetAtTime(liveRef.current.vibrato,now,.025);
  }

  async function startVoice(event:ReactPointerEvent<HTMLDivElement>){
    if(voicesRef.current.has(event.pointerId)||pendingPointersRef.current.has(event.pointerId))return;
    event.preventDefault();
    const point=mapPointer(event);
    if(!point)return;
    pendingPointersRef.current.add(event.pointerId);
    try{surfaceRef.current?.setPointerCapture(event.pointerId)}catch{}
    try{
      const ctx=await ensureAudio(),master=masterRef.current;
      if(!pendingPointersRef.current.has(event.pointerId)||!master)return;
      pendingPointersRef.current.delete(event.pointerId);
      const p=preset(liveRef.current.sound);
      const filter=ctx.createBiquadFilter(),amp=ctx.createGain();
      filter.type='lowpass';filter.Q.value=p.q;filter.frequency.value=p.cutoff;
      amp.gain.value=.0001;

      let oscA:OscillatorNode|null=null,oscB:OscillatorNode|null=null;
      let mixA:GainNode|null=null,mixB:GainNode|null=null;
      let lfo:OscillatorNode|null=null,lfoDepth:GainNode|null=null;
      let noise:AudioBufferSourceNode|null=null,noiseGain:GainNode|null=null;
      let stringDelay:DelayNode|null=null,stringFeedback:GainNode|null=null,stringDamping:BiquadFilterNode|null=null,stringBody:BiquadFilterNode|null=null;

      if(liveRef.current.sound==='geo'){
        const physical=startPhysicalString(ctx,master,point.frequency,amp,filter);
        stringDelay=physical.delay;stringFeedback=physical.feedback;stringDamping=physical.damping;stringBody=physical.body;
        noise=physical.excitation;
      }else{
        oscA=ctx.createOscillator();oscB=ctx.createOscillator();
        mixA=ctx.createGain();mixB=ctx.createGain();
        lfo=ctx.createOscillator();lfoDepth=ctx.createGain();
        if(p.wave==='violin'){
          const wave=periodicWave(ctx,'violin');
          oscA.setPeriodicWave(wave);oscB.setPeriodicWave(wave);
        }else{
          oscA.type=p.a;oscB.type=p.b;
        }
        mixA.gain.value=p.mixA;mixB.gain.value=p.mixB;
        oscB.detune.value=p.detune;
        lfo.type='sine';lfo.frequency.value=p.wave==='violin'?5.3:5.8;lfoDepth.gain.value=liveRef.current.vibrato;
        lfo.connect(lfoDepth);lfoDepth.connect(oscA.detune);lfoDepth.connect(oscB.detune);
        oscA.connect(mixA).connect(filter);oscB.connect(mixB).connect(filter);
        if(p.noise>0){
          noise=ctx.createBufferSource();noise.buffer=bowNoise(ctx);noise.loop=true;
          noiseGain=ctx.createGain();noiseGain.gain.value=p.noise;
          noise.connect(noiseGain).connect(filter);
        }
        filter.connect(amp).connect(master);
      }

      const voice:Voice={pointerId:event.pointerId,model:liveRef.current.sound==='geo'?'string':'osc',oscA,oscB,mixA,mixB,filter,amp,lfo,lfoDepth,noise,noiseGain,stringDelay,stringFeedback,stringDamping,stringBody,ratio:p.ratio,release:p.release,noiseAmount:p.noise,brightMin:p.brightMin,brightRange:p.brightRange,expressionMin:p.expressionMin,expressionRange:p.expressionRange,offset:point.offset};
      voicesRef.current.set(event.pointerId,voice);
      oscA?.start();oscB?.start();lfo?.start();
      if(noise&&liveRef.current.sound!=='geo')noise.start();
      amp.gain.setValueAtTime(.0001,ctx.currentTime);
      amp.gain.exponentialRampToValueAtTime(.13,ctx.currentTime+p.attack);
      setVoiceExpression(voice,point,true);
      setTouches(current=>[...current.filter(t=>t.pointerId!==event.pointerId),{pointerId:event.pointerId,...point}]);
      setStatus(`${noteLabel(point.offset,language)} · ${point.frequency.toFixed(1)} Hz`);
    }catch(error){
      pendingPointersRef.current.delete(event.pointerId);
      setStatus(error instanceof Error?error.message:'Unable to start audio');
    }
  }

  function moveVoice(event:ReactPointerEvent<HTMLDivElement>){
    const voice=voicesRef.current.get(event.pointerId);
    if(!voice)return;
    event.preventDefault();
    const point=mapPointer(event);
    if(!point)return;
    setVoiceExpression(voice,point);
    setTouches(current=>current.map(t=>t.pointerId===event.pointerId?{pointerId:event.pointerId,...point}:t));
    setStatus(`${noteLabel(point.offset,language)} · ${point.frequency.toFixed(1)} Hz`);
  }

  function stopVoice(pointerId:number){
    pendingPointersRef.current.delete(pointerId);
    const voice=voicesRef.current.get(pointerId),ctx=ctxRef.current;
    if(!voice||!ctx){
      setTouches(current=>current.filter(t=>t.pointerId!==pointerId));
      return;
    }
    voicesRef.current.delete(pointerId);
    const now=ctx.currentTime,release=voice.release;
    try{
      voice.amp.gain.cancelScheduledValues(now);
      voice.amp.gain.setTargetAtTime(.0001,now,Math.max(.03,release/4));
      voice.oscA?.stop(now+release);
      voice.oscB?.stop(now+release);
      voice.lfo?.stop(now+release);
      if(voice.noise&&voice.model!=='string')voice.noise.stop(now+release);
      if(voice.stringFeedback)voice.stringFeedback.gain.setTargetAtTime(.0001,now,.08);
    }catch{}
    setTouches(current=>current.filter(t=>t.pointerId!==pointerId));
    if(voicesRef.current.size===0)setStatus('Touch or drag across the surface');
  }

  function loadScaleSa(){
    try{
      const saved=Number(localStorage.getItem('vio-scale-sa-hz'));
      if(Number.isFinite(saved)&&saved>=55&&saved<=880){
        setTonicHz(saved);
        setStatus(`Loaded Scale Practice Sa · ${saved.toFixed(2)} Hz`);
        return;
      }
    }catch{}
    setStatus('No saved Sa yet · set Sa in Scale Practice first');
  }

  useEffect(()=>{
    const master=masterRef.current,ctx=ctxRef.current;
    if(master&&ctx)master.gain.setTargetAtTime(volume,ctx.currentTime,.02);
  },[volume]);

  useEffect(()=>{
    const ctx=ctxRef.current;
    if(!ctx)return;
    for(const voice of voicesRef.current.values()){
      const frequency=tonicHz*Math.pow(2,voice.offset/12);
      if(voice.model==='string'&&voice.stringDelay){
        voice.stringDelay.delayTime.setTargetAtTime(clamp(1/Math.max(35,frequency),.0008,.045),ctx.currentTime,.02);
      }else{
        voice.oscA?.frequency.setTargetAtTime(frequency,ctx.currentTime,.02);
        voice.oscB?.frequency.setTargetAtTime(frequency*voice.ratio,ctx.currentTime,.02);
      }
      voice.lfoDepth?.gain.setTargetAtTime(vibrato,ctx.currentTime,.02);
    }
  },[tonicHz,vibrato]);

  const lead=touches[0]||null;

  return <section className="card instrument-card">
    <div className="card-head">
      <div><h2>Expressive Instrument</h2><span>3-octave · multi-touch pitch surface</span></div>
      <div className="instrument-head-actions">
        <button className="soft-btn instrument-landscape" type="button" onClick={()=>void requestLandscape()}>↻ Landscape</button>
        <div className="pill"><i className="dot-live"/>{touches.length?`${touches.length} touch${touches.length>1?'es':''}`:'Ready'}</div>
      </div>
    </div>

    <div className="instrument-controls">
      <div className="control">
        <div className="control-label"><span>Scale</span></div>
        <select value={scale} onChange={e=>setScale(e.target.value as ScaleId)}>
          {SCALES.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      <div className="control">
        <div className="control-label"><span>Labels</span></div>
        <select value={language} onChange={e=>chooseLanguage(e.target.value as UiLanguage)}>
          {LANGUAGES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div className="control">
        <div className="control-label"><span>Sound</span></div>
        <select value={sound} onChange={e=>setSound(e.target.value as SoundId)}>
          <option value="geo">Geo String</option>
          <option value="violin">Refined Violin</option>
          <option value="bowed">Bowed</option>
          <option value="warm">Warm</option>
          <option value="glass">Glass</option>
        </select>
      </div>
      <div className="control instrument-tonic-control">
        <div className="control-label"><span>Sa / Tonic</span><span>{tonicHz.toFixed(2)} Hz</span></div>
        <div className="instrument-tonic-row">
          <input type="number" min="55" max="880" step=".01" value={Number(tonicHz.toFixed(2))} onChange={e=>setTonicHz(clamp(Number(e.target.value)||C4,55,880))}/>
          <button className="soft-btn" onClick={loadScaleSa}>Use Scale Sa</button>
        </div>
      </div>
    </div>

    <div className="instrument-stage">
      <div className="instrument-readout">
        <div><b>{lead?noteLabel(lead.offset,language):SWARAS[language][0]}</b><span>{lead?`${lead.frequency.toFixed(2)} Hz`:`Sa ${tonicHz.toFixed(2)} Hz`}</span></div>
        <small>← glide / bend · ↑ brighter & louder · multi-touch supported</small>
      </div>

      <div className="instrument-rotate-hint">↻ Rotate to landscape for the full 3-octave surface</div>
      <div
        ref={surfaceRef}
        className="instrument-surface"
        role="application"
        aria-label="Expressive multi-touch musical surface"
        onPointerDown={startVoice}
        onPointerMove={moveVoice}
        onPointerUp={e=>stopVoice(e.pointerId)}
        onPointerCancel={e=>stopVoice(e.pointerId)}
        onLostPointerCapture={e=>stopVoice(e.pointerId)}
      >
        <div className="instrument-surface-grid">
          {cells.map(offset=>{
            const enabled=scaleDef.degrees.includes(mod(offset,12));
            return <div key={offset} className={`instrument-key ${enabled?'in-scale':'out-scale'} ${offset===0?'tonic':''}`}>
              <b>{noteLabel(offset,language)}</b>
              <small>{offset===0?'Sa':offset>0?`+${offset}`:offset}</small>
            </div>
          })}
        </div>
        {touches.map(touch=><i key={touch.pointerId} className="instrument-touch" style={{left:`${touch.x*100}%`,top:`${touch.y*100}%`}}/>)}
      </div>
      <div className="instrument-axis"><span>Lower</span><b>Pitch glide</b><span>Higher</span></div>
    </div>

    <div className="instrument-footer">
      <label className="toggle instrument-lock"><span>Scale lock</span><input type="checkbox" checked={scaleLock} onChange={e=>setScaleLock(e.target.checked)}/></label>
      <div className="instrument-slider"><div className="control-label"><span>Vibrato</span><span>{vibrato}¢</span></div><input className="range" type="range" min="0" max="35" value={vibrato} onChange={e=>setVibrato(+e.target.value)}/></div>
      <div className="instrument-slider"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>setVolume(+e.target.value/100)}/></div>
      <div className="instrument-status status">{status}</div>
    </div>
  </section>;
}
