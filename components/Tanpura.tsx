'use client';

import { useEffect, useRef, useState } from 'react';

const KEYS=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
function keyFreq(key:string){return 130.81278265*Math.pow(2,KEYS.indexOf(key)/12)}

export default function Tanpura(){
  const [pattern,setPattern]=useState<'sa-pa'|'sa-ma'>('sa-pa');
  const [key,setKey]=useState('C');
  const [volume,setVolume]=useState(.6);
  const [playing,setPlaying]=useState(false);
  const [status,setStatus]=useState('Ready');
  const audioRef=useRef<HTMLAudioElement|null>(null),ctxRef=useRef<AudioContext|null>(null),masterRef=useRef<GainNode|null>(null),timerRef=useRef<ReturnType<typeof setInterval>|null>(null),nodesRef=useRef<AudioScheduledSourceNode[]>([]);

  function stop(update=true){
    if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}
    if(timerRef.current){clearInterval(timerRef.current);timerRef.current=null}
    nodesRef.current.forEach(n=>{try{n.stop()}catch{}});nodesRef.current=[];masterRef.current=null;setPlaying(false);if(update)setStatus('Stopped');
  }
  useEffect(()=>()=>stop(false),[]);

  function pluck(ctx:AudioContext,dest:AudioNode,freq:number,when:number,amp:number){
    const osc=ctx.createOscillator(),gain=ctx.createGain(),filter=ctx.createBiquadFilter();osc.type='sawtooth';osc.frequency.value=freq;filter.type='lowpass';filter.frequency.value=Math.min(4200,freq*10);gain.gain.setValueAtTime(.0001,when);gain.gain.exponentialRampToValueAtTime(amp,when+.015);gain.gain.exponentialRampToValueAtTime(.0001,when+2.7);osc.connect(filter).connect(gain).connect(dest);osc.start(when);osc.stop(when+2.8);nodesRef.current.push(osc)
  }
  async function synth(){
    const AC=audioContextCtor();if(!AC){setStatus('Web Audio unavailable');return}const ctx=ctxRef.current||(ctxRef.current=new AC());if(ctx.state==='suspended')await ctx.resume();const master=ctx.createGain();master.gain.value=volume;master.connect(ctx.destination);masterRef.current=master;const sa=keyFreq(key),other=sa*Math.pow(2,(pattern==='sa-pa'?7:5)/12);const cycle=()=>{const t=ctx.currentTime+.03;pluck(ctx,master,other,t,.14);pluck(ctx,master,sa,t+.72,.17);pluck(ctx,master,sa*2,t+1.44,.12);pluck(ctx,master,sa,t+2.16,.16)};cycle();timerRef.current=setInterval(cycle,2880);setStatus('Synth fallback');setPlaying(true)
  }
  async function start(){
    stop(false);const stem=key.replace('#','s'),audio=new Audio(`/assets/tanpura/${pattern}_${stem}.mp3`);audio.loop=true;audio.volume=volume;audioRef.current=audio;try{await audio.play();setPlaying(true);setStatus(`${key} · ${pattern==='sa-pa'?'SA PA':'SA MA'}`)}catch{audioRef.current=null;await synth()}
  }
  useEffect(()=>{if(playing)start()},[pattern,key]);

  return <>
    <div className="page-head"><div><p className="eyebrow">Continuous drone</p><h1>Tanpura</h1><p>Choose Sa and a drone pattern.</p></div><div className="badge">12 keys · SA PA / SA MA</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Tanpura Drone</h2></div><span>{status}</span></div>
      <div className="tanpura-layout">
        <div className={`tan-visual ${playing?'playing':''}`}><div className="tan-ring"/><div className="tan-ring two"/><div className="tan-body"><div className="tan-neck"/><div className="tan-gourd"><div className="tan-om">ॐ</div></div></div></div>
        <div className="section">
          <div className="control"><div className="control-label"><span>Drone pattern</span></div><div className="seg two"><button className={pattern==='sa-pa'?'active':''} onClick={()=>setPattern('sa-pa')}>सा पा · SA PA</button><button className={pattern==='sa-ma'?'active':''} onClick={()=>setPattern('sa-ma')}>सा मा · SA MA</button></div></div>
          <div className="control"><div className="control-label"><span>Sa / Key</span></div><div className="key-grid">{KEYS.map(k=><button key={k} className={key===k?'active':''} onClick={()=>setKey(k)}>{k}</button>)}</div></div>
          <div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>{const v=+e.target.value/100;setVolume(v);if(audioRef.current)audioRef.current.volume=v;if(masterRef.current)masterRef.current.gain.value=v}}/></div>
          <button className={`primary ${playing?'danger':''}`} onClick={playing?()=>stop():start}>{playing?'Stop':'Play'}</button>
        </div>
      </div>
    </section>
  </>;
}
