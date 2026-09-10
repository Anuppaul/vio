'use client';

import { useEffect, useRef, useState } from 'react';

const KEYS=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
function keyFreq(key:string){return 130.81278265*Math.pow(2,KEYS.indexOf(key)/12)}

function loopBounds(buffer:AudioBuffer){
  const length=buffer.length,channels=buffer.numberOfChannels;
  let peak=0;
  for(let ch=0;ch<channels;ch++){
    const data=buffer.getChannelData(ch);
    for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(data[i]));
  }
  if(peak<=1e-6)return {start:0,end:buffer.duration};
  const threshold=Math.max(peak*.008,.00035),window=Math.max(32,Math.floor(buffer.sampleRate*.006));
  const active=(from:number,to:number)=>{
    let sum=0,count=0;
    for(let ch=0;ch<channels;ch++){
      const data=buffer.getChannelData(ch);
      for(let i=from;i<to;i++){sum+=data[i]*data[i];count++}
    }
    return count?Math.sqrt(sum/count):0;
  };
  let first=0,last=length;
  for(let i=0;i<length-window;i+=window){if(active(i,i+window)>=threshold){first=i;break}}
  for(let i=length-window;i>first;i-=window){if(active(i,i+window)>=threshold){last=Math.min(length,i+window);break}}
  const lead=Math.floor(buffer.sampleRate*.012),tail=Math.floor(buffer.sampleRate*.012);
  first=Math.max(0,first-lead);last=Math.min(length,last+tail);
  const zeroCross=(index:number,radius:number)=>{
    const data=buffer.getChannelData(0);let best=index,bestAmp=Math.abs(data[index]||0);
    const lo=Math.max(1,index-radius),hi=Math.min(length-2,index+radius);
    for(let i=lo;i<=hi;i++){
      const amp=Math.abs(data[i]);
      if((data[i]===0||data[i]*data[i+1]<=0)&&amp<bestAmp){best=i;bestAmp=amp}
    }
    return best;
  };
  first=zeroCross(first,Math.floor(buffer.sampleRate*.006));
  last=zeroCross(Math.max(first+2,last-1),Math.floor(buffer.sampleRate*.006))+1;
  if(last-first<buffer.sampleRate*.5)return {start:0,end:buffer.duration};
  return {start:first/buffer.sampleRate,end:last/buffer.sampleRate};
}

export default function Tanpura(){
  const [pattern,setPattern]=useState<'sa-pa'|'sa-ma'>('sa-pa');
  const [key,setKey]=useState('C');
  const [volume,setVolume]=useState(.6);
  const [playing,setPlaying]=useState(false);
  const [status,setStatus]=useState('Ready');
  const ctxRef=useRef<AudioContext|null>(null),masterRef=useRef<GainNode|null>(null),sourceRef=useRef<AudioBufferSourceNode|null>(null),timerRef=useRef<ReturnType<typeof setInterval>|null>(null),nodesRef=useRef<AudioScheduledSourceNode[]>([]);
  const cacheRef=useRef(new Map<string,AudioBuffer>()),tokenRef=useRef(0);

  function stop(update=true){
    tokenRef.current++;
    try{sourceRef.current?.stop()}catch{}sourceRef.current=null;
    if(timerRef.current){clearInterval(timerRef.current);timerRef.current=null}
    nodesRef.current.forEach(n=>{try{n.stop()}catch{}});nodesRef.current=[];
    if(masterRef.current&&ctxRef.current){try{masterRef.current.gain.cancelScheduledValues(ctxRef.current.currentTime)}catch{}}
    masterRef.current=null;setPlaying(false);if(update)setStatus('Stopped');
  }
  useEffect(()=>()=>stop(false),[]);

  function pluck(ctx:AudioContext,dest:AudioNode,freq:number,when:number,amp:number){
    const osc=ctx.createOscillator(),gain=ctx.createGain(),filter=ctx.createBiquadFilter();osc.type='sawtooth';osc.frequency.value=freq;filter.type='lowpass';filter.frequency.value=Math.min(4200,freq*10);gain.gain.setValueAtTime(.0001,when);gain.gain.exponentialRampToValueAtTime(amp,when+.015);gain.gain.exponentialRampToValueAtTime(.0001,when+2.7);osc.connect(filter).connect(gain).connect(dest);osc.start(when);osc.stop(when+2.8);nodesRef.current.push(osc)
  }
  async function synth(){
    const AC=audioContextCtor();if(!AC){setStatus('Web Audio unavailable');return}const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();const master=ctx.createGain();master.gain.value=volume;master.connect(ctx.destination);masterRef.current=master;const sa=keyFreq(key),other=sa*Math.pow(2,(pattern==='sa-pa'?7:5)/12);const cycle=()=>{const t=ctx.currentTime+.03;pluck(ctx,master,other,t,.14);pluck(ctx,master,sa,t+.72,.17);pluck(ctx,master,sa*2,t+1.44,.12);pluck(ctx,master,sa,t+2.16,.16)};cycle();timerRef.current=setInterval(cycle,2880);setStatus('Synth fallback');setPlaying(true)
  }
  async function start(){
    stop(false);const token=tokenRef.current;const AC=audioContextCtor();if(!AC){await synth();return}
    const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();
    const stem=key.replace('#','s'),url=`/assets/tanpura/${pattern}_${stem}.mp3`;
    setStatus('Loading drone…');
    try{
      let buffer=cacheRef.current.get(url);
      if(!buffer){const response=await fetch(url);if(!response.ok)throw new Error('sample unavailable');buffer=await ctx.decodeAudioData(await response.arrayBuffer());cacheRef.current.set(url,buffer)}
      if(token!==tokenRef.current)return;
      const master=ctx.createGain(),source=ctx.createBufferSource(),bounds=loopBounds(buffer);
      master.gain.setValueAtTime(0,ctx.currentTime);master.gain.linearRampToValueAtTime(volume,ctx.currentTime+.035);master.connect(ctx.destination);
      source.buffer=buffer;source.loop=true;source.loopStart=bounds.start;source.loopEnd=bounds.end;source.connect(master);source.start(ctx.currentTime+.015,bounds.start);
      masterRef.current=master;sourceRef.current=source;setPlaying(true);setStatus(`${key} · ${pattern==='sa-pa'?'SA PA':'SA MA'} · Gapless`);
    }catch{if(token===tokenRef.current)await synth()}
  }
  useEffect(()=>{if(playing)void start()},[pattern,key]);

  return <>
    <div className="page-head"><div><p className="eyebrow">Continuous drone</p><h1>Tanpura</h1><p>Choose Sa and a drone pattern.</p></div><div className="badge">12 keys · SA PA / SA MA</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Tanpura Drone</h2></div><span>{status}</span></div>
      <div className="tanpura-layout">
        <div className={`tan-visual ${playing?'playing':''}`}><div className="tan-ring"/><div className="tan-ring two"/><div className="tan-body"><div className="tan-neck"/><div className="tan-gourd"><div className="tan-om">ॐ</div></div></div></div>
        <div className="section">
          <div className="control"><div className="control-label"><span>Drone pattern</span></div><div className="seg two"><button className={pattern==='sa-pa'?'active':''} onClick={()=>setPattern('sa-pa')}>सा पा · SA PA</button><button className={pattern==='sa-ma'?'active':''} onClick={()=>setPattern('sa-ma')}>सा मा · SA MA</button></div></div>
          <div className="control"><div className="control-label"><span>Sa / Key</span></div><div className="key-grid">{KEYS.map(k=><button key={k} className={key===k?'active':''} onClick={()=>setKey(k)}>{k}</button>)}</div></div>
          <div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>{const v=+e.target.value/100;setVolume(v);if(masterRef.current&&ctxRef.current)masterRef.current.gain.setTargetAtTime(v,ctxRef.current.currentTime,.015)}}/></div>
          <button className={`primary ${playing?'danger':''}`} onClick={playing?()=>stop():start}>{playing?'Stop':'Play'}</button>
        </div>
      </div>
    </section>
  </>;
}
