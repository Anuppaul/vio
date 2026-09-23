'use client';

import { useEffect, useRef, useState } from 'react';
import { createBrowserAudioContext, resumeBrowserAudio } from '@/lib/browser-audio';


type TempoPreset={name:string;range:string;bpm:number;description:string};
type TempoGroup={title:string;subtitle:string;presets:TempoPreset[]};
const TEMPO_GROUPS:TempoGroup[]=[
 {title:'Slow Tempos',subtitle:'The Broad & Solemn Category',presets:[
  {name:'Larghissimo',range:'under 20–24 BPM',bpm:20,description:'Extremely slow, broad, and long'},
  {name:'Grave',range:'20–40 BPM',bpm:30,description:'Very slow, heavy, solemn, and serious'},
  {name:'Largo',range:'40–60 BPM',bpm:50,description:'Broad, wide, stately, and slow'},
  {name:'Lento',range:'45–60 BPM',bpm:52,description:'Slow and smoothly flowing'},
  {name:'Larghetto',range:'60–66 BPM',bpm:63,description:'A little broad; slightly faster than Largo'},
  {name:'Adagio',range:'66–76 BPM',bpm:71,description:'Slow, at ease, and expressive'},
  {name:'Adagietto',range:'72–80 BPM',bpm:76,description:'Fairly slow, slightly faster than Adagio'}
 ]},
 {title:'Moderate Tempos',subtitle:'The Walking & Intermediate Category',presets:[
  {name:'Andante',range:'76–108 BPM',bpm:92,description:'At a moderate walking pace'},
  {name:'Andantino',range:'80–108 BPM',bpm:94,description:'Slightly faster than a walking pace'},
  {name:'Andante moderato',range:'92–112 BPM',bpm:102,description:'Medium walking pace'},
  {name:'Moderato',range:'108–120 BPM',bpm:114,description:'Moderately, at a neutral middle-ground speed'}
 ]},
 {title:'Fast Tempos',subtitle:'The Lively & Fast Category',presets:[
  {name:'Allegretto',range:'112–120 BPM',bpm:116,description:'Moderately fast, light, and cheerful'},
  {name:'Allegro moderato',range:'116–120 BPM',bpm:118,description:'Moderately quick and lively'},
  {name:'Allegro',range:'120–156 BPM',bpm:138,description:'Fast, quick, bright, and energetic'},
  {name:'Allegro animato',range:'126–144 BPM',bpm:135,description:'Animated, lively, and fast'},
  {name:'Allegro con brio',range:'132–144 BPM',bpm:138,description:'Fast with spirit, fire, and brilliance'},
  {name:'Vivace',range:'140–176 BPM',bpm:158,description:'Lively, brisk, and fast'},
  {name:'Allegro vivace',range:'144–160 BPM',bpm:152,description:'Very fast and lively'},
  {name:'Allegro assai',range:'144–176 BPM',bpm:160,description:'Very fast'},
  {name:'Vivacissimo',range:'172–176 BPM',bpm:174,description:'Very fast and lively, faster than Vivace'},
  {name:'Allegro molto / Molto allegro',range:'160–180 BPM',bpm:170,description:'Extremely fast and driven'},
  {name:'Presto',range:'168–200 BPM',bpm:184,description:'Very quickly and rapid'},
  {name:'Prestissimo',range:'200+ BPM',bpm:208,description:'As fast as possible; extremely fast'}
 ]}
];
const TEMPO_PRESETS=TEMPO_GROUPS.flatMap(group=>group.presets);
const files={click:'/assets/metronome/click.wav',accent:'/assets/metronome/click-accent.wav',tablaNa:'/assets/metronome/tabla-na.wav',tablaTin:'/assets/metronome/tabla-tin.wav',tablaGe:'/assets/metronome/tabla-ge.wav',kick:'/assets/metronome/drum-kick.wav',snare:'/assets/metronome/drum-snare.wav',hat:'/assets/metronome/drum-hihat.wav'};
type Sound='click'|'tabla'|'drum';
type Subdivision=1|2|3|4;

function SubdivisionIcon({kind}:{kind:Subdivision}){
 const common={fill:'currentColor',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};
 if(kind===1)return <svg viewBox="0 0 30 26" width="29" height="24" aria-hidden="true" focusable="false"><ellipse cx="10" cy="19" rx="4.2" ry="3.2" transform="rotate(-15 10 19)" fill="currentColor"/><line x1="13.7" y1="18" x2="13.7" y2="5" {...common}/></svg>;
 if(kind===2)return <svg viewBox="0 0 32 26" width="29" height="24" aria-hidden="true" focusable="false"><ellipse cx="7" cy="20" rx="3.8" ry="3" transform="rotate(-15 7 20)" fill="currentColor"/><ellipse cx="23" cy="17" rx="3.8" ry="3" transform="rotate(-15 23 17)" fill="currentColor"/><line x1="10.4" y1="19" x2="10.4" y2="6" {...common}/><line x1="26.4" y1="16" x2="26.4" y2="3" {...common}/><path d="M10.4 6 L26.4 3 L26.4 7 L10.4 10 Z" fill="currentColor" stroke="none"/></svg>;
 if(kind===3)return <svg viewBox="0 0 38 29" width="32" height="25" aria-hidden="true" focusable="false"><path d="M4 5 V2 H34 V5" fill="none" {...common}/><text x="19" y="7.5" textAnchor="middle" fontSize="6.5" fontWeight="900" fill="currentColor" stroke="none">3</text><ellipse cx="7" cy="23" rx="3.5" ry="2.8" transform="rotate(-15 7 23)" fill="currentColor"/><ellipse cx="18" cy="21" rx="3.5" ry="2.8" transform="rotate(-15 18 21)" fill="currentColor"/><ellipse cx="29" cy="19" rx="3.5" ry="2.8" transform="rotate(-15 29 19)" fill="currentColor"/><line x1="10" y1="22" x2="10" y2="10" {...common}/><line x1="21" y1="20" x2="21" y2="8" {...common}/><line x1="32" y1="18" x2="32" y2="6" {...common}/><path d="M10 10 L32 6 L32 9.5 L10 13.5 Z" fill="currentColor" stroke="none"/></svg>;
 return <svg viewBox="0 0 32 27" width="29" height="24" aria-hidden="true" focusable="false"><ellipse cx="7" cy="22" rx="3.8" ry="3" transform="rotate(-15 7 22)" fill="currentColor"/><ellipse cx="23" cy="19" rx="3.8" ry="3" transform="rotate(-15 23 19)" fill="currentColor"/><line x1="10.4" y1="21" x2="10.4" y2="6" {...common}/><line x1="26.4" y1="18" x2="26.4" y2="3" {...common}/><path d="M10.4 6 L26.4 3 L26.4 6.5 L10.4 9.5 Z" fill="currentColor" stroke="none"/><path d="M10.4 11 L26.4 8 L26.4 11.5 L10.4 14.5 Z" fill="currentColor" stroke="none"/></svg>;
}

function normalizeBuffer(ctx:AudioContext,buffer:AudioBuffer,target=.98){
 let peak=0;
 for(let c=0;c<buffer.numberOfChannels;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++){const a=Math.abs(data[i]);if(a>peak)peak=a}}
 if(peak<=0||peak>=target*.995)return buffer;
 const out=ctx.createBuffer(buffer.numberOfChannels,buffer.length,buffer.sampleRate),scale=target/peak;
 for(let c=0;c<buffer.numberOfChannels;c++){const src=buffer.getChannelData(c),dst=out.getChannelData(c);for(let i=0;i<src.length;i++)dst[i]=Math.max(-1,Math.min(1,src[i]*scale))}
 return out;
}

export default function Metronome(){
 const [bpm,setBpmState]=useState(120),[beats,setBeatsState]=useState(4),[subdivision,setSubdivisionState]=useState(1),[sound,setSound]=useState<Sound>('click'),[accent,setAccent]=useState(true),[flash,setFlash]=useState(true),[volume,setVolume]=useState(.95),[running,setRunning]=useState(false),[activeBeat,setActiveBeat]=useState(-1),[status,setStatus]=useState('Ready'),[side,setSide]=useState(false);
 const ctxRef=useRef<AudioContext|null>(null),masterRef=useRef<GainNode|null>(null),limiterRef=useRef<DynamicsCompressorNode|null>(null),buffersRef=useRef<Record<string,AudioBuffer>>({}),timerRef=useRef<ReturnType<typeof setTimeout>|null>(null),rafRef=useRef(0),nextRef=useRef(0),stepRef=useRef(0),queueRef=useRef<{time:number,beat:number,sub:number,down:boolean}[]>([]),tapRef=useRef<number[]>([]),runningRef=useRef(false);
 const live=useRef({bpm,beats,subdivision,sound,accent,flash,volume});useEffect(()=>{live.current={bpm,beats,subdivision,sound,accent,flash,volume}},[bpm,beats,subdivision,sound,accent,flash,volume]);
 const tempoName=TEMPO_PRESETS.reduce((best,preset)=>Math.abs(preset.bpm-bpm)<Math.abs(best.bpm-bpm)?preset:best,TEMPO_PRESETS[0]).name;
 function setBpm(v:number){setBpmState(Math.max(20,Math.min(300,Math.round(v))))}
 function chooseTempo(preset:TempoPreset){setBpm(preset.bpm);setStatus(`${preset.name} · ${preset.bpm} BPM`)}
 async function ensureAudio(){const ctx=ctxRef.current||createBrowserAudioContext();if(!ctx)throw new Error('Web Audio unavailable');ctxRef.current=ctx;if(!masterRef.current){const gain=ctx.createGain(),limiter=ctx.createDynamicsCompressor();gain.gain.value=live.current.volume*1.18;limiter.threshold.value=-1.5;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=.001;limiter.release.value=.06;gain.connect(limiter).connect(ctx.destination);masterRef.current=gain;limiterRef.current=limiter}await resumeBrowserAudio(ctx);return ctx}
 useEffect(()=>{ensureAudio().then(async ctx=>{await Promise.all(Object.entries(files).map(async([key,url])=>{try{const res=await fetch(url);if(!res.ok)return;const decoded=await ctx.decodeAudioData(await res.arrayBuffer());buffersRef.current[key]=(key==='click'||key==='accent')?normalizeBuffer(ctx,decoded,.98):decoded}catch{}}));setStatus('Ready')}).catch(()=>setStatus('Web Audio unavailable'));return()=>{stop();cancelAnimationFrame(rafRef.current)}},[]);
 function playBuffer(key:string,when:number,gainValue=1){const buffer=buffersRef.current[key],ctx=ctxRef.current,master=masterRef.current;if(!buffer||!ctx||!master)return false;const src=ctx.createBufferSource(),gain=ctx.createGain();src.buffer=buffer;gain.gain.value=gainValue;src.connect(gain).connect(master);src.start(when);return true}
 function playClickBuffer(key:string,when:number,level=1){const buffer=buffersRef.current[key],ctx=ctxRef.current,master=masterRef.current;if(!buffer||!ctx||!master)return false;const src=ctx.createBufferSource(),pre=ctx.createGain(),comp=ctx.createDynamicsCompressor(),makeup=ctx.createGain();src.buffer=buffer;pre.gain.value=level;comp.threshold.value=-10;comp.knee.value=3;comp.ratio.value=3.5;comp.attack.value=.0008;comp.release.value=.045;makeup.gain.value=2.15;src.connect(pre).connect(comp).connect(makeup).connect(master);src.start(when);return true}
 function synthClick(when:number,isAccent=false,level=1){const ctx=ctxRef.current,master=masterRef.current;if(!ctx||!master)return;const high=ctx.createOscillator(),body=ctx.createOscillator(),highGain=ctx.createGain(),bodyGain=ctx.createGain();high.type='square';body.type='triangle';high.frequency.setValueAtTime(isAccent?3600:2800,when);high.frequency.exponentialRampToValueAtTime(isAccent?2200:1750,when+.028);body.frequency.setValueAtTime(isAccent?520:410,when);body.frequency.exponentialRampToValueAtTime(isAccent?240:190,when+.045);highGain.gain.setValueAtTime(.0001,when);highGain.gain.exponentialRampToValueAtTime((isAccent?1.15:.95)*level,when+.0008);highGain.gain.exponentialRampToValueAtTime(.0001,when+.035);bodyGain.gain.setValueAtTime(.0001,when);bodyGain.gain.exponentialRampToValueAtTime((isAccent?.55:.42)*level,when+.001);bodyGain.gain.exponentialRampToValueAtTime(.0001,when+.055);high.connect(highGain).connect(master);body.connect(bodyGain).connect(master);high.start(when);body.start(when);high.stop(when+.04);body.stop(when+.06)}
 function scheduleSound(when:number,beat:number,sub:number){const s=live.current,isMain=sub===0,isDown=beat===0&&isMain;if(s.sound==='click'){const key=isDown&&s.accent?'accent':'click',level=isDown&&s.accent?1.38:isMain?1.18:.48;if(!playClickBuffer(key,when,level))synthClick(when,isDown&&s.accent,level);return}if(s.sound==='tabla'){if(isMain){if(isDown){playBuffer('tablaGe',when,s.accent?1.12:.96);playBuffer('tablaNa',when+.012,.56)}else playBuffer(beat%2?'tablaNa':'tablaTin',when,.9)}else playBuffer('tablaTin',when,.31);return}if(isMain){if(isDown||beat%2===0)playBuffer('kick',when,isDown&&s.accent?1.12:.92);else playBuffer('snare',when,.9);if(isDown&&s.accent)playBuffer('hat',when,.55)}else playBuffer('hat',when,.38)}
 function scheduler(){const ctx=ctxRef.current;if(!ctx||!runningRef.current)return;const s=live.current,horizon=ctx.currentTime+(document.hidden?.7:.16),sec=(60/s.bpm)/s.subdivision;while(nextRef.current<horizon){const beat=Math.floor(stepRef.current/s.subdivision)%s.beats,sub=stepRef.current%s.subdivision,down=beat===0&&sub===0;scheduleSound(nextRef.current,beat,sub);queueRef.current.push({time:nextRef.current,beat,sub,down});nextRef.current+=sec;stepRef.current=(stepRef.current+1)%(s.beats*s.subdivision)}timerRef.current=setTimeout(scheduler,document.hidden?120:25)}
 function animate(){const ctx=ctxRef.current;if(ctx){const now=ctx.currentTime;while(queueRef.current.length&&queueRef.current[0].time<=now+.012){const e=queueRef.current.shift()!;if(e.sub===0){setActiveBeat(e.beat);setSide(v=>!v);if(live.current.flash&&typeof document.body.animate==='function'){document.body.animate([{filter:e.down?'brightness(1.02) saturate(1.05)':'brightness(1.01)'},{filter:'none'}],{duration:180})}}}}rafRef.current=requestAnimationFrame(animate)}
 async function start(){if(runningRef.current)return;await ensureAudio();runningRef.current=true;setRunning(true);stepRef.current=0;queueRef.current=[];nextRef.current=ctxRef.current!.currentTime+.06;setStatus(`${bpm} BPM · ${beats} beats`);scheduler();rafRef.current=requestAnimationFrame(animate)}
 function stop(){runningRef.current=false;if(timerRef.current)clearTimeout(timerRef.current);timerRef.current=null;setRunning(false);queueRef.current=[];setActiveBeat(-1);setStatus('Stopped')}
 useEffect(()=>{if(masterRef.current&&ctxRef.current)masterRef.current.gain.setTargetAtTime(volume*1.18,ctxRef.current.currentTime,.015)},[volume]);
 function tap(){const now=performance.now(),a=tapRef.current;if(a.length&&now-a[a.length-1]>2000)a.length=0;a.push(now);if(a.length>8)a.shift();if(a.length>=2){const ints=a.slice(1).map((t,i)=>t-a[i]),sorted=[...ints].sort((x,y)=>x-y),med=sorted[Math.floor(sorted.length/2)],filtered=ints.filter(v=>Math.abs(v-med)<med*.28),used=filtered.length?filtered:ints;setBpm(60000/(used.reduce((x,y)=>x+y,0)/used.length));setStatus('Tap tempo')}}
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName||''))return;if(e.code==='Space'){e.preventDefault();running?stop():start()}else if(e.key.toLowerCase()==='t')tap();else if(e.code==='ArrowUp'){e.preventDefault();setBpm(bpm+(e.shiftKey?5:1))}else if(e.code==='ArrowDown'){e.preventDefault();setBpm(bpm-(e.shiftKey?5:1))}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)},[running,bpm]);
 useEffect(()=>{stepRef.current=0},[beats,subdivision]);
 return <>
  <section className="card"><div className="card-head"><div><h2>Practice Metronome</h2></div><span>{status}</span></div><div className="metro-layout"><div className="metro-player"><div className="bpm-zone"><button className="round" onClick={()=>setBpm(bpm-1)}>−</button><div className="bpm-center"><span className="tempo-name">{tempoName}</span><div><input className="bpm-input" type="number" min="20" max="300" value={bpm} onChange={e=>setBpm(+e.target.value)}/><b className="muted"> BPM</b></div></div><button className="round" onClick={()=>setBpm(bpm+1)}>+</button></div><input className="range" type="range" min="20" max="300" value={bpm} onChange={e=>setBpm(+e.target.value)}/><div className="surface"><div className="pendulum" style={{transform:`rotate(${side?28:-28}deg)`,['--swing' as string]:`${(60/bpm)*.48}s`}}/><div className="beat-dots">{Array.from({length:beats},(_,i)=><i key={i} className={`beat-dot ${activeBeat===i?'active':''} ${activeBeat===0&&i===0?'down':''}`}/>)}</div></div><div className="actions"><button className={`primary ${running?'danger':''}`} onClick={running?stop:start}>{running?'Stop':'Start'}</button><button className="soft-btn" onClick={tap}>Tap Tempo</button></div></div><aside className="metro-settings"><div className="control"><div className="control-label"><span>Beats per bar</span></div><div className="seg seven">{[1,2,3,4,5,6,7].map(n=><button key={n} className={beats===n?'active':''} onClick={()=>setBeatsState(n)}>{n}</button>)}</div></div><div className="control"><div className="control-label"><span>Subdivision</span></div><div className="seg two">{([{n:1,label:'Quarter'},{n:2,label:'Eighths'},{n:3,label:'Triplets'},{n:4,label:'Sixteenths'}] as const).map(({n,label})=><button key={n} className={subdivision===n?'active':''} onClick={()=>setSubdivisionState(n)} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:7,minHeight:46,padding:'4px 7px'}}><SubdivisionIcon kind={n}/><span>{label}</span></button>)}</div></div><div className="control"><div className="control-label"><span>Sound</span></div><div className="seg three">{(['click','tabla','drum'] as Sound[]).map(s=><button key={s} className={sound===s?'active':''} onClick={()=>setSound(s)}>{s[0].toUpperCase()+s.slice(1)}</button>)}</div></div><div className="control"><label className="toggle"><span>Accent first beat</span><input type="checkbox" checked={accent} onChange={e=>setAccent(e.target.checked)}/></label><label className="toggle"><span>Visual flash</span><input type="checkbox" checked={flash} onChange={e=>setFlash(e.target.checked)}/></label></div><div className="control"><div className="control-label"><span>Volume</span><span>{Math.round(volume*100)}%</span></div><input className="range" type="range" min="0" max="100" value={volume*100} onChange={e=>setVolume(+e.target.value/100)}/></div></aside></div>
   <div className="tempo-presets"><div className="tempo-badge-row">{TEMPO_PRESETS.map(preset=><button type="button" key={preset.name} className={bpm===preset.bpm?'active':''} title={`${preset.name} · ${preset.range} · ${preset.description}`} onClick={()=>chooseTempo(preset)}><b>{preset.name}</b><span>{preset.bpm}</span></button>)}</div></div>
  </section>
 </>
}
