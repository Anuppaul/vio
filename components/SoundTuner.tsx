'use client';

import { useEffect, useRef, useState } from 'react';
import { PitchDetector } from 'pitchy';
import { OPEN_STRINGS, median, midiFrequency, noteFromFrequencyRange, rms } from '@/lib/music';

const OPEN_LABELS=['G3','D4','A4','E5'];
const LEVEL_BUFFER_SIZE=8192;
const MID_BUFFER_SIZE=4096;
const FAST_BUFFER_SIZE=2048;
const CAPTURE_CHUNK_SIZE=1024;
const HPS_BUFFER_SIZE=CAPTURE_CHUNK_SIZE*50;
const ANALYSIS_MS=65;
const RMS_MIN=.00045;
const MPM_MIN_CLARITY=.72;
const MPM_MID_MIN_CLARITY=.70;
const MPM_FAST_MIN_CLARITY=.68;
const MPM_SINGLE_STRONG=.91;
const MIN_CANDIDATE_CLARITY=.26;
const ACCEPT_CLARITY=.42;
const STRONG_CLARITY=.76;
const NOISE_MARGIN=2.15;
const CLEAR_AFTER_MISSES=12;
const CENTS_DEADBAND=.22;
const LOW_OCTAVE_VERIFY_MAX_HZ=400;
const HPS_EVIDENCE_MAX_AGE_MS=1400;

function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}
function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}
function centsApart(a:number,b:number){return Math.abs(1200*Math.log2(a/b))}

type HpsWorkerResult={frequency:number;clarity:number;source:'hps'|'direct';hpsFrequency?:number;directFrequency?:number;octaveCorrected?:boolean};
type HpsWorkerMessage={id:number;result?:HpsWorkerResult|null;error?:string};
type PitchEvidence={frequency:number;clarity:number;at:number};
type HpsEvidence={result:HpsWorkerResult;at:number};
type MpmCandidate={frequency:number;clarity:number;window:'long'|'mid'|'fast'};

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

  const ctxRef=useRef<AudioContext|null>(null),analyserRef=useRef<AnalyserNode|null>(null),sourceRef=useRef<MediaStreamAudioSourceNode|null>(null),highPassRef=useRef<BiquadFilterNode|null>(null),lowPassRef=useRef<BiquadFilterNode|null>(null),processorRef=useRef<ScriptProcessorNode|null>(null),silentGainRef=useRef<GainNode|null>(null),streamRef=useRef<MediaStream|null>(null);
  const bufferRef=useRef(new Float32Array(LEVEL_BUFFER_SIZE)),cleanRef=useRef(new Float32Array(LEVEL_BUFFER_SIZE));
  const captureRef=useRef(new Float32Array(HPS_BUFFER_SIZE)),captureWriteRef=useRef(0),captureCountRef=useRef(0);
  const rafRef=useRef(0),lastRef=useRef(0),missRef=useRef(0),historyRef=useRef<number[]>([]),pendingMidiRef=useRef<number|null>(null),pendingCountRef=useRef(0),lockedMidiRef=useRef<number|null>(null),lastStatusRef=useRef('');
  const noiseFloorRef=useRef(.00032),smoothedCentsRef=useRef(0),hasCentsSmoothRef=useRef(false),smoothedFrequencyRef=useRef<number|null>(null),a4Ref=useRef(440);
  const workerRef=useRef<Worker|null>(null),workerBusyRef=useRef(false),workerSeqRef=useRef(0),latestMpmRef=useRef<PitchEvidence|null>(null),latestHpsRef=useRef<HpsEvidence|null>(null);
  const longDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null),midDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null),fastDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  if(!longDetectorRef.current){const d=PitchDetector.forFloat32Array(LEVEL_BUFFER_SIZE);d.clarityThreshold=.90;d.minVolumeAbsolute=0;longDetectorRef.current=d}
  if(!midDetectorRef.current){const d=PitchDetector.forFloat32Array(MID_BUFFER_SIZE);d.clarityThreshold=.88;d.minVolumeAbsolute=0;midDetectorRef.current=d}
  if(!fastDetectorRef.current){const d=PitchDetector.forFloat32Array(FAST_BUFFER_SIZE);d.clarityThreshold=.86;d.minVolumeAbsolute=0;fastDetectorRef.current=d}

  useEffect(()=>{a4Ref.current=a4},[a4]);

  function cleanFrame(input:Float32Array,out:Float32Array){let mean=0;for(let i=0;i<input.length;i++)mean+=input[i];mean/=input.length;for(let i=0;i<input.length;i++)out[i]=input[i]-mean}
  function pushCapture(chunk:Float32Array){const ring=captureRef.current;let write=captureWriteRef.current;for(let i=0;i<chunk.length;i++){ring[write]=chunk[i];write++;if(write===ring.length)write=0}captureWriteRef.current=write;captureCountRef.current=Math.min(ring.length,captureCountRef.current+chunk.length)}
  function captureFrame(){if(captureCountRef.current<HPS_BUFFER_SIZE)return null;const ring=captureRef.current,out=new Float32Array(HPS_BUFFER_SIZE),write=captureWriteRef.current,tail=ring.length-write;out.set(ring.subarray(write),0);if(write>0)out.set(ring.subarray(0,write),tail);return out}
  function resetCapture(){captureWriteRef.current=0;captureCountRef.current=0;captureRef.current.fill(0)}
  function updateNoiseFloor(volume:number){const old=noiseFloorRef.current,learnBelow=Math.max(.0038,old*1.8);if(volume<learnBelow){const alpha=volume<old*1.6?.055:.006;noiseFloorRef.current=Math.max(.00012,Math.min(.004,old*(1-alpha)+volume*alpha))}return Math.max(RMS_MIN,noiseFloorRef.current*NOISE_MARGIN)}
  function smoothFrequency(raw:number,quality:number){const limit=raw>=700?5:9;historyRef.current.push(raw);if(historyRef.current.length>limit)historyRef.current.shift();const logs=historyRef.current.map(v=>Math.log2(v)),robust=Math.pow(2,median(logs));if(smoothedFrequencyRef.current===null){smoothedFrequencyRef.current=robust;return robust}const current=smoothedFrequencyRef.current,delta=1200*Math.log2(robust/current),alpha=raw>=700?(Math.abs(delta)>35?.70:quality>=.85?.48:.34):(Math.abs(delta)>35?.62:quality>=.85?.38:.25);const next=current*Math.pow(2,delta*alpha/1200);smoothedFrequencyRef.current=next;return next}
  function smoothCents(raw:number){if(!hasCentsSmoothRef.current){smoothedCentsRef.current=raw;hasCentsSmoothRef.current=true;return raw}const delta=raw-smoothedCentsRef.current;if(Math.abs(delta)<CENTS_DEADBAND)return smoothedCentsRef.current;const alpha=Math.abs(delta)>12?.46:Math.abs(delta)>5?.31:.20;smoothedCentsRef.current+=delta*alpha;return smoothedCentsRef.current}
  function resetPitchSmoothing(){historyRef.current=[];smoothedFrequencyRef.current=null;hasCentsSmoothRef.current=false}
  function clearPitch(){setNote('—');setFrequency(null);setCents(null);setClarity(0);pendingMidiRef.current=null;pendingCountRef.current=0;lockedMidiRef.current=null;latestMpmRef.current=null;latestHpsRef.current=null;resetPitchSmoothing()}
  function resetReading(){clearPitch();setMicLevel(0);missRef.current=0;noiseFloorRef.current=.00032;resetCapture()}
  function setLiveStatus(text:string){if(lastStatusRef.current===text)return;lastStatusRef.current=text;setStatus(text)}
  function stopReference(){if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}try{oscRef.current?.stop()}catch{}oscRef.current=null;gainRef.current=null;setActiveRef(null)}

  async function playReference(midi:number){stopReference();setActiveRef(midi);const label=OPEN_LABELS[OPEN_STRINGS.indexOf(midi as typeof OPEN_STRINGS[number])];const sample=`/assets/ear/${label}.mp3`,audio=new Audio(sample);audio.loop=loop;audio.volume=.72;audio.playbackRate=a4/440;audioRef.current=audio;try{await audio.play();setStatus(`Reference ${label} · ${midiFrequency(midi,a4).toFixed(2)} Hz`)}catch{const AC=audioContextCtor();if(!AC){setStatus('Web Audio unavailable');return}const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=midiFrequency(midi,a4);osc.type='sine';gain.gain.value=.13;osc.connect(gain).connect(ctx.destination);osc.start();oscRef.current=osc;gainRef.current=gain;setStatus(`Reference ${label} · oscillator`);if(!loop)setTimeout(()=>{try{osc.stop()}catch{}setActiveRef(null)},2000)}}

  function acceptPitch(raw:number,quality:number,engine='McLeod'){const tuning=a4Ref.current,immediate=noteFromFrequencyRange(raw,tuning);if(!immediate)return;const candidate=immediate.midi,current=lockedMidiRef.current;if(current===null||current!==candidate){if(pendingMidiRef.current===candidate)pendingCountRef.current++;else{pendingMidiRef.current=candidate;pendingCountRef.current=1}let required=current===null?(quality>=STRONG_CLARITY?2:quality>=ACCEPT_CLARITY?3:4):4;if(current!==null){const jump=Math.abs(candidate-current),octaveJump=jump>=12&&jump%12===0;if(octaveJump)required=5;else if(jump>=7)required=4;if(quality>=.92)required=Math.max(2,required-1)}if(pendingCountRef.current<required){setLiveStatus(`${engine} checking · ${immediate.label}`);return}lockedMidiRef.current=candidate;pendingMidiRef.current=null;pendingCountRef.current=0;resetPitchSmoothing()}else{pendingMidiRef.current=null;pendingCountRef.current=0}const stable=smoothFrequency(raw,quality),mapped=noteFromFrequencyRange(stable,tuning);if(!mapped)return;if(lockedMidiRef.current!==mapped.midi){setLiveStatus(`${engine} holding current note · verifying ${immediate.label}`);return}const softCents=smoothCents(mapped.cents);setNote(mapped.label);setFrequency(stable);setCents(softCents);setClarity(quality);missRef.current=0;setLiveStatus(`${engine} locked · ${mapped.label}`)}

  function detectMpmConsensus(clean:Float32Array,sampleRate:number,tuning:number){
    const candidates:MpmCandidate[]=[];
    const add=(detector:ReturnType<typeof PitchDetector.forFloat32Array>|null,frame:Float32Array,minClarity:number,window:MpmCandidate['window'])=>{if(!detector)return;const [frequency,clarity]=detector.findPitch(frame,sampleRate);if(frequency>0&&clarity>=minClarity&&noteFromFrequencyRange(frequency,tuning))candidates.push({frequency,clarity,window})};
    add(longDetectorRef.current,clean,MPM_MIN_CLARITY,'long');
    add(midDetectorRef.current,clean.subarray(LEVEL_BUFFER_SIZE-MID_BUFFER_SIZE),MPM_MID_MIN_CLARITY,'mid');
    add(fastDetectorRef.current,clean.subarray(LEVEL_BUFFER_SIZE-FAST_BUFFER_SIZE),MPM_FAST_MIN_CLARITY,'fast');
    if(!candidates.length)return null;
    const clusters:{items:MpmCandidate[]}[]=[];
    for(const candidate of candidates){let best:{items:MpmCandidate[]}|null=null,bestDistance=Infinity;for(const cluster of clusters){let total=0,weight=0;for(const item of cluster.items){const w=Math.max(.1,item.clarity);total+=Math.log(item.frequency)*w;weight+=w}const center=Math.exp(total/weight),distance=centsApart(candidate.frequency,center);if(distance<=55&&distance<bestDistance){best=cluster;bestDistance=distance}}if(best)best.items.push(candidate);else clusters.push({items:[candidate]})}
    clusters.sort((a,b)=>{const score=(c:{items:MpmCandidate[]})=>c.items.length*2+c.items.reduce((s,i)=>s+i.clarity,0);return score(b)-score(a)});
    const winner=clusters[0];
    if(winner.items.length>=2){let total=0,weight=0,clarity=0;for(const item of winner.items){const w=Math.max(.1,item.clarity);total+=Math.log(item.frequency)*w;weight+=w;clarity+=item.clarity}return{frequency:Math.exp(total/weight),clarity:Math.min(.99,clarity/winner.items.length+.04),engine:`McLeod ${winner.items.map(i=>i.window).join('+')}`}}
    const only=winner.items[0];
    if(candidates.length===1&&only.clarity>=MPM_SINGLE_STRONG)return{frequency:only.frequency,clarity:only.clarity,engine:`McLeod ${only.window}`};
    if(only.frequency>=700&&only.clarity>=.94)return{frequency:only.frequency,clarity:only.clarity,engine:`McLeod ${only.window} strong`};
    return null;
  }

  function resolvePrimaryPitch(mpmFrequency:number,mpmClarity:number,engine:string){const evidence=latestHpsRef.current;if(!evidence||Date.now()-evidence.at>HPS_EVIDENCE_MAX_AGE_MS)return{frequency:mpmFrequency,clarity:mpmClarity,engine};const hps=evidence.result,distance=centsApart(hps.frequency,mpmFrequency);if(distance<=45){const wm=Math.max(.1,mpmClarity),wh=Math.max(.1,hps.clarity),frequency=Math.exp((Math.log(mpmFrequency)*wm+Math.log(hps.frequency)*wh)/(wm+wh));return{frequency,clarity:Math.min(.99,Math.max(mpmClarity,hps.clarity)+.04),engine:`${engine} + HPS`}}const oneOctave=Math.abs(distance-1200)<=70;if(mpmFrequency<LOW_OCTAVE_VERIFY_MAX_HZ&&oneOctave&&hps.frequency<mpmFrequency){const directSupportsUpper=!!hps.directFrequency&&centsApart(hps.directFrequency,mpmFrequency)<=90;const reliableLower=hps.source==='hps'&&hps.clarity>=.58&&(hps.octaveCorrected||directSupportsUpper);if(reliableLower)return{frequency:hps.frequency,clarity:Math.max(hps.clarity,mpmClarity*.90),engine:'Low-octave corrected'}}return{frequency:mpmFrequency,clarity:mpmClarity,engine}}

  function handleHpsPitch(result:HpsWorkerResult|null){if(result)latestHpsRef.current={result,at:Date.now()};const mpm=latestMpmRef.current;if(mpm&&Date.now()-mpm.at<=450&&mpm.clarity>=MPM_MIN_CLARITY)return;const quality=result?.clarity??0;if(result&&result.frequency<LOW_OCTAVE_VERIFY_MAX_HZ&&noteFromFrequencyRange(result.frequency,a4Ref.current)&&quality>=MIN_CANDIDATE_CLARITY){acceptPitch(result.frequency,quality,result.octaveCorrected?'HPS octave-corrected':'HPS low fallback');return}if(!mpm){missRef.current++;if(missRef.current>CLEAR_AFTER_MISSES)clearPitch()}}

  function startHpsWorker(){if(typeof Worker==='undefined')return;try{const worker=new Worker('/hps-worker.js');worker.onmessage=(event:MessageEvent<HpsWorkerMessage>)=>{workerBusyRef.current=false;if(!analyserRef.current)return;if(event.data?.error){setLiveStatus('HPS helper unavailable · McLeod remains active');return}handleHpsPitch(event.data?.result??null)};worker.onerror=()=>{workerBusyRef.current=false;try{worker.terminate()}catch{}if(workerRef.current===worker)workerRef.current=null;setLiveStatus('HPS helper unavailable · McLeod remains active')};workerRef.current=worker;workerBusyRef.current=false}catch{workerRef.current=null}}
  function stopHpsWorker(){try{workerRef.current?.terminate()}catch{}workerRef.current=null;workerBusyRef.current=false}

  function analyse(ts:number){const analyser=analyserRef.current,ctx=ctxRef.current;if(!analyser||!ctx)return;if(ts-lastRef.current>=ANALYSIS_MS){lastRef.current=ts;const input=bufferRef.current,clean=cleanRef.current;analyser.getFloatTimeDomainData(input);cleanFrame(input,clean);const volume=rms(clean),level=levelPercent(volume),gate=updateNoiseFloor(volume);setMicLevel(level);if(volume>=gate){const tuning=a4Ref.current,minHz=midiFrequency(23.5,tuning),maxHz=midiFrequency(103.5,tuning);const consensus=detectMpmConsensus(clean,ctx.sampleRate,tuning);if(consensus){latestMpmRef.current={frequency:consensus.frequency,clarity:consensus.clarity,at:Date.now()};const hpsEvidence=latestHpsRef.current,hpsFresh=!!hpsEvidence&&Date.now()-hpsEvidence.at<=HPS_EVIDENCE_MAX_AGE_MS;const needsLowOctaveCheck=consensus.frequency<LOW_OCTAVE_VERIFY_MAX_HZ&&lockedMidiRef.current===null&&!!workerRef.current;if(needsLowOctaveCheck&&!hpsFresh){setClarity(consensus.clarity);setLiveStatus(`Verifying low-register octave · HPS buffer ${Math.min(100,Math.round(captureCountRef.current/HPS_BUFFER_SIZE*100))}%`)}else{const resolved=resolvePrimaryPitch(consensus.frequency,consensus.clarity,consensus.engine);acceptPitch(resolved.frequency,resolved.clarity,resolved.engine)}}else{const prior=latestMpmRef.current;if(prior&&Date.now()-prior.at>350)latestMpmRef.current=null;pendingMidiRef.current=null;pendingCountRef.current=0;setLiveStatus('McLeod windows disagree · holding stable note')}
        const worker=workerRef.current;if(worker&&!workerBusyRef.current){const frame=captureFrame();if(frame){workerBusyRef.current=true;const id=++workerSeqRef.current;worker.postMessage({id,samples:frame.buffer,sampleRate:ctx.sampleRate,minFreq:Math.max(50,minHz),maxFreq:maxHz},[frame.buffer])}}
        if(!consensus){setClarity(0)}
      }else{latestMpmRef.current=null;latestHpsRef.current=null;missRef.current++;setClarity(0);setLiveStatus(level>0?'Noise filtered · play a steady note':'Listening · play a note');if(missRef.current>CLEAR_AFTER_MISSES)clearPitch()}}
    rafRef.current=requestAnimationFrame(analyse)}

  async function start(){if(running)return;stopReference();const AC=audioContextCtor();if(!AC||!navigator.mediaDevices?.getUserMedia){setStatus('Microphone API unavailable');return}try{const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});const ctx=ctxRef.current||(ctxRef.current=new AC({latencyHint:'interactive'}));if(ctx.state==='suspended')await ctx.resume();const source=ctx.createMediaStreamSource(stream),highPass=ctx.createBiquadFilter(),lowPass=ctx.createBiquadFilter(),analyser=ctx.createAnalyser(),processor=ctx.createScriptProcessor(CAPTURE_CHUNK_SIZE,1,1),silentGain=ctx.createGain();highPass.type='highpass';highPass.frequency.value=18;highPass.Q.value=.707;lowPass.type='lowpass';lowPass.frequency.value=Math.min(12000,ctx.sampleRate*.42);lowPass.Q.value=.45;analyser.fftSize=LEVEL_BUFFER_SIZE;analyser.smoothingTimeConstant=0;silentGain.gain.value=0;processor.onaudioprocess=e=>{const channel=e.inputBuffer.getChannelData(0);pushCapture(channel);for(let c=0;c<e.outputBuffer.numberOfChannels;c++)e.outputBuffer.getChannelData(c).fill(0)};source.connect(highPass).connect(lowPass);lowPass.connect(analyser);lowPass.connect(processor).connect(silentGain).connect(ctx.destination);streamRef.current=stream;sourceRef.current=source;highPassRef.current=highPass;lowPassRef.current=lowPass;analyserRef.current=analyser;processorRef.current=processor;silentGainRef.current=silentGain;startHpsWorker();setRunning(true);resetReading();lastStatusRef.current='';setLiveStatus('Listening · multi-window McLeod + low-octave HPS check active');lastRef.current=0;rafRef.current=requestAnimationFrame(analyse)}catch(err){setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`)}}
  function stop(){cancelAnimationFrame(rafRef.current);rafRef.current=0;stopHpsWorker();if(processorRef.current)processorRef.current.onaudioprocess=null;try{sourceRef.current?.disconnect();highPassRef.current?.disconnect();lowPassRef.current?.disconnect();analyserRef.current?.disconnect();processorRef.current?.disconnect();silentGainRef.current?.disconnect()}catch{}streamRef.current?.getTracks().forEach(t=>t.stop());sourceRef.current=null;highPassRef.current=null;lowPassRef.current=null;analyserRef.current=null;processorRef.current=null;silentGainRef.current=null;streamRef.current=null;setRunning(false);resetReading();lastStatusRef.current='';setStatus('Microphone stopped')}
  useEffect(()=>()=>{cancelAnimationFrame(rafRef.current);streamRef.current?.getTracks().forEach(t=>t.stop());if(processorRef.current)processorRef.current.onaudioprocess=null;stopHpsWorker();stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,cents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  const activeRange=frequency?noteFromFrequencyRange(frequency,a4):null;
  const activeMidi=activeRange?activeRange.midi:null;

  return <>
    <div className="page-head"><div><p className="eyebrow">Universal chromatic tuner</p><h1>Sound Tuner</h1><p>Three McLeod analysis windows track low, mid and high registers independently. GuitarTuner-style FFT/HPS is restricted to low-register octave verification.</p></div><div className="badge">Mic → 3-window McLeod consensus → note → cents</div></div>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}% · Confidence ${Math.round(clarity*100)}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap jelly-gauge">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?(micLevel>2?'Sound detected · checking pitch consensus':'Play a clear steady tone'):inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row">{OPEN_STRINGS.map((midi,i)=><span className={`target-chip ${activeMidi===midi?'active':''}`} key={midi}>{OPEN_LABELS[i]} · {midiFrequency(midi,a4).toFixed(1)} Hz</span>)}</div>
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
