'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FLAT_NAMES, NOTE_NAMES, midiFrequency } from '@/lib/music';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';

const ranges = [62,69,76,83].map(top => Array.from({length:15},(_,i)=>top-i));
const presets: Record<string, number[]> = { standard:[55,62,69,76], aeae:[57,64,69,76], adae:[57,62,69,76], pasapasa:[55,60,67,72] };

function displayName(midi:number, flats:boolean, octave=true){
  const names=flats?FLAT_NAMES:NOTE_NAMES;
  const name=names[((midi%12)+12)%12];
  return octave?`${name}${Math.floor(midi/12)-1}`:name;
}
function asciiCandidates(midi:number){
  const sharps=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const flats=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const pc=((midi%12)+12)%12,oct=Math.floor(midi/12)-1,sharp=`${sharps[pc]}${oct}`,flat=`${flats[pc]}${oct}`;
  const names=[sharp,flat,String(midi),`${pc}_${oct}`];
  if(sharp.includes('#')){const l=sharp[0];names.unshift(`${l}s${oct}`,`${l}sharp${oct}`,`${l}-sharp${oct}`)}
  return [...new Set(names)].map(n=>`/assets/ear/${encodeURIComponent(n)}.mp3`);
}

type SampleLoop={buffer:AudioBuffer;start:number;end:number};

function activeSampleBounds(buffer:AudioBuffer){
  const data=buffer.getChannelData(0),rate=buffer.sampleRate,length=data.length;
  let peak=0;
  for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(data[i]));
  if(peak<1e-5)return {start:0,end:buffer.duration};

  const window=Math.max(32,Math.floor(rate*.008));
  const threshold=Math.max(.00025,peak*.012);
  const windowRms=(from:number)=>{
    const to=Math.min(length,from+window);
    let sum=0;
    for(let i=from;i<to;i++)sum+=data[i]*data[i];
    return Math.sqrt(sum/Math.max(1,to-from));
  };

  let first=0,last=length;
  for(let i=0;i<length-window;i+=window){
    if(windowRms(i)>=threshold){first=i;break}
  }
  for(let i=Math.max(0,length-window);i>first;i-=window){
    if(windowRms(i)>=threshold){last=Math.min(length,i+window);break}
  }

  return {
    start:Math.max(0,(first-Math.floor(rate*.01))/rate),
    end:Math.min(buffer.duration,(last+Math.floor(rate*.01))/rate)
  };
}

function nearestZeroCrossing(
  buffer:AudioBuffer,
  target:number,
  radius:number,
  direction?:number
){
  const data=buffer.getChannelData(0),length=data.length;
  const center=Math.max(1,Math.min(length-2,Math.round(target)));
  const lo=Math.max(1,center-radius),hi=Math.min(length-2,center+radius);
  let best=center,bestScore=Number.POSITIVE_INFINITY;
  for(let i=lo;i<=hi;i++){
    const up=data[i]<=0&&data[i+1]>0,down=data[i]>=0&&data[i+1]<0;
    if(!up&&!down)continue;
    const crossingDirection=up?1:-1;
    if(direction!==undefined&&crossingDirection!==direction)continue;
    const distance=Math.abs(i-center)/Math.max(1,radius);
    const amplitude=Math.abs(data[i])+Math.abs(data[i+1]);
    const score=amplitude+distance*.002;
    if(score<bestScore){best=i;bestScore=score}
  }
  return best;
}

function gaplessLoopBounds(buffer:AudioBuffer,midi:number){
  const rate=buffer.sampleRate,active=activeSampleBounds(buffer);
  const activeDuration=active.end-active.start;
  if(activeDuration<.45)return active;

  const attackSkip=Math.min(.32,activeDuration*.18);
  const tailSkip=Math.min(.22,activeDuration*.12);
  const safeStart=active.start+attackSkip;
  const safeEnd=active.end-tailSkip;
  if(safeEnd-safeStart<.35)return active;

  const period=rate/midiFrequency(midi);
  const startRadius=Math.max(Math.floor(rate*.01),Math.ceil(period));
  const startIndex=nearestZeroCrossing(buffer,safeStart*rate,startRadius);
  const data=buffer.getChannelData(0);
  const startDirection=data[startIndex]<=0&&data[startIndex+1]>0?1:-1;

  const available=Math.max(period*4,safeEnd*rate-startIndex);
  const cycles=Math.max(4,Math.floor(available/period));
  const idealEnd=startIndex+cycles*period;
  const endRadius=Math.max(Math.ceil(period*.65),Math.floor(rate*.012));
  let endIndex=nearestZeroCrossing(buffer,idealEnd,endRadius,startDirection);

  const minimumLoop=Math.floor(rate*.30);
  if(endIndex-startIndex<minimumLoop){
    endIndex=nearestZeroCrossing(buffer,safeEnd*rate,endRadius,startDirection);
  }
  if(endIndex<=startIndex+minimumLoop||endIndex>=buffer.length-1)return active;

  return {start:startIndex/rate,end:endIndex/rate};
}

export default function EarTuner(){
  const [notes,setNotes]=useState([55,62,69,76]);
  const [tone,setTone]=useState<'natural'|'beep'>('natural');
  const [flats,setFlats]=useState(false);
  const [loop,setLoop]=useState(true);
  const [volume,setVolume]=useState(.7);
  const [active,setActive]=useState(-1);
  const [status,setStatus]=useState('Ready');
  const ctxRef=useRef<AudioContext|null>(null);
  const oscRef=useRef<OscillatorNode|null>(null);
  const gainRef=useRef<GainNode|null>(null);
  const sampleSourceRef=useRef<AudioBufferSourceNode|null>(null);
  const sampleGainRef=useRef<GainNode|null>(null);
  const sampleCacheRef=useRef(new Map<string,SampleLoop>());
  const tokenRef=useRef(0);

  const preset=useMemo(()=>Object.entries(presets).find(([,v])=>v.every((n,i)=>n===notes[i]))?.[0]||'', [notes]);

  function stop(update=true){
    tokenRef.current++;
    try{sampleSourceRef.current?.stop()}catch{}
    try{oscRef.current?.stop()}catch{}
    sampleSourceRef.current=null;sampleGainRef.current=null;
    oscRef.current=null;gainRef.current=null;setActive(-1);if(update)setStatus('Stopped');
  }
  useEffect(()=>()=>stop(false),[]);

  async function beep(midi:number,index:number){
    const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx){setStatus('Web Audio unavailable');return}ctxRef.current=ctx;await resumeBrowserAudio(ctx);
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type='sine';osc.frequency.value=midiFrequency(midi);gain.gain.value=volume*.5;osc.connect(gain).connect(ctx.destination);osc.start();oscRef.current=osc;gainRef.current=gain;setActive(index);setStatus(`${displayName(midi,flats)} · ${midiFrequency(midi).toFixed(2)} Hz`);
    if(!loop)setTimeout(()=>{if(oscRef.current===osc)stop(false)},1800);
  }

  async function playSample(midi:number,index:number){
    stop(false);
    const token=tokenRef.current,urls=asciiCandidates(midi);
    const ctx=ctxRef.current||createBrowserAudioContext();
    if(!ctx){setStatus('Web Audio unavailable');return}
    ctxRef.current=ctx;
    await resumeBrowserAudio(ctx);

    for(const url of urls){
      if(token!==tokenRef.current)return;
      try{
        let sample=sampleCacheRef.current.get(url);
        if(!sample){
          const response=await fetch(url);
          if(!response.ok)continue;
          const buffer=await ctx.decodeAudioData(await response.arrayBuffer());
          const bounds=gaplessLoopBounds(buffer,midi);
          sample={buffer,start:bounds.start,end:bounds.end};
          sampleCacheRef.current.set(url,sample);
        }
        if(token!==tokenRef.current)return;

        const source=ctx.createBufferSource(),gain=ctx.createGain();
        source.buffer=sample.buffer;
        source.loopStart=sample.start;
        source.loopEnd=sample.end;
        source.loop=loop;
        gain.gain.value=volume;
        source.connect(gain).connect(ctx.destination);
        sampleSourceRef.current=source;
        sampleGainRef.current=gain;
        source.onended=()=>{
          if(sampleSourceRef.current!==source)return;
          sampleSourceRef.current=null;sampleGainRef.current=null;
          setActive(-1);setStatus('Ready');
        };
        source.start();
        setActive(index);
        setStatus(`${displayName(midi,flats)} · natural sample${loop?' · seamless loop':''}`);
        return;
      }catch{}
    }

    if(token!==tokenRef.current)return;
    await beep(midi,index);
    setStatus(`${displayName(midi,flats)} · oscillator fallback`);
  }
  function playMidi(midi:number,index:number){
    if(tone==='natural')playSample(midi,index);
    else{stop(false);void beep(midi,index)}
  }
  function play(index:number){playMidi(notes[index],index)}
  function selectNote(index:number,midi:number){
    const wasPlaying=active===index;
    setNotes(v=>v.map((n,i)=>i===index?midi:n));
    if(wasPlaying)playMidi(midi,index);
  }

  return <>
    <section className="card">
      <div className="card-head"><div><h2>String reference</h2></div><span>{status}</span></div>
      <div className="grid-2">
        <div className="section">
          <div className="string-heads"><span>String 4</span><span>String 3</span><span>String 2</span><span>String 1</span></div>
          <div className="note-grid">{Array.from({length:15},(_,row)=>ranges.map((range,s)=>{const midi=range[row];return <button key={`${s}-${midi}`} className={`note-cell ${notes[s]===midi?'active':''}`} onClick={()=>selectNote(s,midi)}>{displayName(midi,flats)}</button>}))}</div>
          <div className="players">{notes.map((midi,i)=><div className="player-card" key={i}><b>{displayName(midi,flats,false)}</b><small>{displayName(midi,flats)} · {midiFrequency(midi).toFixed(2)} Hz</small><button className={active===i?'active':''} onClick={()=>active===i?stop():play(i)}>{active===i?'STOP':'PLAY'}</button></div>)}</div>
        </div>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Tuning</span></div><select value={preset} onChange={e=>{if(e.target.value)setNotes([...presets[e.target.value]])}}><option value="">Custom</option><option value="standard">Standard · G D A E</option><option value="aeae">Cross · A E A E</option><option value="adae">Cross · A D A E</option><option value="pasapasa">Cross · G C G C · পা সা পা সা</option></select></div>
          <div className="control"><div className="control-label"><span>Tone</span></div><div className="seg two"><button className={tone==='natural'?'active':''} onClick={()=>setTone('natural')}>Natural</button><button className={tone==='beep'?'active':''} onClick={()=>setTone('beep')}>Beep</button></div></div>
          <div className="control"><div className="control-label"><span>Notation</span></div><div className="seg two"><button className={!flats?'active':''} onClick={()=>setFlats(false)}>Sharps ♯</button><button className={flats?'active':''} onClick={()=>setFlats(true)}>Flats ♭</button></div></div>
          <div className="control"><div className="control-label"><span>Repeat</span></div><div className="seg two"><button className={loop?'active':''} onClick={()=>{setLoop(true);if(sampleSourceRef.current)sampleSourceRef.current.loop=true}}>Loop</button><button className={!loop?'active':''} onClick={()=>{setLoop(false);if(sampleSourceRef.current)sampleSourceRef.current.loop=false}}>Once</button></div></div>
          <div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>{const v=+e.target.value/100;setVolume(v);if(sampleGainRef.current)sampleGainRef.current.gain.value=v;if(gainRef.current)gainRef.current.gain.value=v*.5}}/></div>
          <button className="primary danger" onClick={()=>stop()}>Stop sound</button>
        </aside>
      </div>
    </section>
  </>;
}
