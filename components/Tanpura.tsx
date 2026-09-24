'use client';

import { useEffect, useRef, useState } from 'react';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';

const KEYS=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function keyFreq(key:string){return 130.81278265*Math.pow(2,KEYS.indexOf(key)/12)}

function zeroCrossNear(buffer:AudioBuffer,index:number,radius:number){
  const data=buffer.getChannelData(0),length=buffer.length;
  const center=Math.max(1,Math.min(length-2,Math.round(index)));
  const lo=Math.max(1,center-radius),hi=Math.min(length-2,center+radius);
  let best=center,bestAmp=Math.abs(data[center]||0);
  for(let i=lo;i<=hi;i++){
    const crossing=data[i]===0||data[i]*data[i+1]<=0;
    if(!crossing)continue;
    const amp=Math.abs(data[i]);
    if(amp<bestAmp){best=i;bestAmp=amp}
  }
  return best;
}

function seamCost(buffer:AudioBuffer,start:number,end:number){
  const window=Math.max(64,Math.floor(buffer.sampleRate*.10));
  const points=96,step=Math.max(1,Math.floor(window/points));
  let total=0;
  for(let ch=0;ch<buffer.numberOfChannels;ch++){
    const data=buffer.getChannelData(ch);
    let dot=0,a2=0,b2=0;
    for(let i=0;i<points;i++){
      const offset=i*step;
      const a=data[Math.min(data.length-1,start+offset)]||0;
      const b=data[Math.min(data.length-1,end+offset)]||0;
      dot+=a*b;a2+=a*a;b2+=b*b;
    }
    const corr=(a2>1e-12&&b2>1e-12)?dot/Math.sqrt(a2*b2):0;
    const rmsA=Math.sqrt(a2/points),rmsB=Math.sqrt(b2/points);
    const rmsCost=Math.abs(Math.log((rmsA+1e-8)/(rmsB+1e-8)));
    const edgeCost=Math.min(1,Math.abs((data[start]||0)-(data[end]||0))/.05);
    const slopeA=(data[Math.min(data.length-1,start+1)]||0)-(data[start]||0);
    const slopeB=(data[Math.min(data.length-1,end+1)]||0)-(data[end]||0);
    const slopeCost=Math.min(1,Math.abs(slopeA-slopeB)/.02);
    total+=(1-Math.max(-1,Math.min(1,corr)))*.68+rmsCost*.18+edgeCost*.08+slopeCost*.06;
  }
  return total/Math.max(1,buffer.numberOfChannels);
}

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

function compactLoopBounds(buffer:AudioBuffer){
  const active=loopBounds(buffer);
  const duration=active.end-active.start;
  if(duration<=14)return active;

  const rate=buffer.sampleRate;
  const safeStart=active.start+2;
  const safeEnd=active.end-2;
  const target=10;
  const baseStart=Math.min(
    safeEnd-target-1,
    Math.max(safeStart,active.start+Math.min(15,duration*.25))
  );
  const zeroRadius=Math.max(24,Math.floor(rate*.004));
  let best={start:baseStart,end:baseStart+target,cost:Number.POSITIVE_INFINITY};

  for(let startOffset=-1;startOffset<=1.0001;startOffset+=.25){
    const startIndex=zeroCrossNear(buffer,(baseStart+startOffset)*rate,zeroRadius);
    const start=startIndex/rate;
    if(start<safeStart||start>safeEnd-9)continue;

    for(let candidateDuration=9;candidateDuration<=11.0001;candidateDuration+=.025){
      const endIndex=zeroCrossNear(buffer,(start+candidateDuration)*rate,zeroRadius);
      const end=endIndex/rate;
      if(end>safeEnd||end-start<8.8)continue;
      const cost=
        seamCost(buffer,startIndex,endIndex)+
        Math.abs((end-start)-target)*.035;
      if(cost<best.cost)best={start,end,cost};
    }
  }

  if(!Number.isFinite(best.cost))return active;
  return {start:best.start,end:best.end};
}

export default function Tanpura(){
  const [pattern,setPattern]=useState<'sa-pa'|'sa-ma'>('sa-pa');
  const [key,setKey]=useState('C');
  const [volume,setVolume]=useState(.6);
  const [playing,setPlaying]=useState(false);
  const [status,setStatus]=useState('Ready');
  const ctxRef=useRef<AudioContext|null>(null),masterRef=useRef<GainNode|null>(null),sourceRef=useRef<AudioBufferSourceNode|null>(null),timerRef=useRef<ReturnType<typeof setInterval>|null>(null),nodesRef=useRef<AudioScheduledSourceNode[]>([]);
  const cacheRef=useRef(new Map<string,AudioBuffer>()),tokenRef=useRef(0);

  function outputChain(ctx:AudioContext){
    const input=ctx.createGain(),master=ctx.createGain();
    input.gain.value=1;
    master.gain.value=volume*.85;
    input.connect(master).connect(ctx.destination);
    masterRef.current=master;
    return input;
  }

  function stop(update=true){
    tokenRef.current++;
    try{sourceRef.current?.stop()}catch{}sourceRef.current=null;
    if(timerRef.current){clearInterval(timerRef.current);timerRef.current=null}
    nodesRef.current.forEach(n=>{try{n.stop()}catch{}});nodesRef.current=[];
    if(masterRef.current&&ctxRef.current){try{masterRef.current.gain.cancelScheduledValues(ctxRef.current.currentTime);masterRef.current.gain.setTargetAtTime(0,ctxRef.current.currentTime,.018)}catch{}}
    masterRef.current=null;setPlaying(false);if(update)setStatus('Stopped');
  }
  useEffect(()=>()=>stop(false),[]);

  function pluck(ctx:AudioContext,dest:AudioNode,freq:number,when:number,amp:number){
    const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sawtooth';osc.frequency.value=freq;gain.gain.setValueAtTime(.0001,when);gain.gain.exponentialRampToValueAtTime(amp,when+.015);gain.gain.exponentialRampToValueAtTime(.0001,when+2.7);osc.connect(gain).connect(dest);osc.start(when);osc.stop(when+2.8);nodesRef.current.push(osc)
  }
  async function synth(){
    const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx){setStatus('Web Audio unavailable');return}ctxRef.current=ctx;await resumeBrowserAudio(ctx);const input=outputChain(ctx);const sa=keyFreq(key),other=sa*Math.pow(2,(pattern==='sa-pa'?7:5)/12);const cycle=()=>{const t=ctx.currentTime+.03;pluck(ctx,input,other,t,.14);pluck(ctx,input,sa,t+.72,.17);pluck(ctx,input,sa*2,t+1.44,.12);pluck(ctx,input,sa,t+2.16,.16)};cycle();timerRef.current=setInterval(cycle,2880);setStatus('Synth fallback');setPlaying(true)
  }
  async function start(){
    stop(false);const token=tokenRef.current;const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx){await synth();return}ctxRef.current=ctx;await resumeBrowserAudio(ctx);
    const stem=key.replace('#','s'),url=`/assets/tanpura/${pattern}_${stem}.mp3`;
    setStatus('Loading drone…');
    try{
      let buffer=cacheRef.current.get(url);
      if(!buffer){const response=await fetch(url);if(!response.ok)throw new Error('sample unavailable');buffer=await ctx.decodeAudioData(await response.arrayBuffer());cacheRef.current.set(url,buffer)}
      if(token!==tokenRef.current)return;
      const input=outputChain(ctx),source=ctx.createBufferSource();
      const bounds=compactLoopBounds(buffer);
      const loopSeconds=Math.max(.1,bounds.end-bounds.start);
      masterRef.current!.gain.setValueAtTime(0,ctx.currentTime);masterRef.current!.gain.linearRampToValueAtTime(volume*.85,ctx.currentTime+.055);
      source.buffer=buffer;source.loop=true;source.loopStart=bounds.start;source.loopEnd=bounds.end;source.connect(input);source.start(ctx.currentTime+.015,bounds.start);
      sourceRef.current=source;setPlaying(true);
      setStatus(`${key} · ${pattern==='sa-pa'?'SA PA':'SA MA'} · Compact ${loopSeconds.toFixed(1)}s · Raw MP3`);
    }catch{if(token===tokenRef.current)await synth()}
  }
  useEffect(()=>{if(playing)void start()},[pattern,key]);

  return <>
    <section className="card">
      <div className="card-head"><div><h2>Tanpura Drone</h2></div><span>{status}</span></div>
      <div className="tanpura-layout">
        <div className={`tan-visual ${playing?'playing':''}`}><div className="tan-ring"/><div className="tan-ring two"/><div className="tan-body"><div className="tan-neck"/><div className="tan-gourd"><div className="tan-om">ॐ</div></div></div></div>
        <div className="section">
          <div className="control"><div className="control-label"><span>Drone pattern</span></div><div className="seg two"><button className={pattern==='sa-pa'?'active':''} onClick={()=>setPattern('sa-pa')}>सा पा · SA PA</button><button className={pattern==='sa-ma'?'active':''} onClick={()=>setPattern('sa-ma')}>सा मा · SA MA</button></div></div>
          <div className="control"><div className="control-label"><span>Sa / Key</span></div><div className="key-grid">{KEYS.map(k=><button key={k} className={key===k?'active':''} onClick={()=>setKey(k)}>{k}</button>)}</div></div>
          <div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>{const v=+e.target.value/100;setVolume(v);if(masterRef.current&&ctxRef.current)masterRef.current.gain.setTargetAtTime(v*.85,ctxRef.current.currentTime,.02)}}/></div>
          <button className={`primary ${playing?'danger':''}`} onClick={playing?()=>stop():start}>{playing?'Stop':'Play'}</button>
        </div>
      </div>
    </section>
  </>;
}
