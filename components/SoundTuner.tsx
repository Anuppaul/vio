'use client';

import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { PitchDetector } from 'pitchy';
import { OPEN_STRINGS, midiFrequency, noteFromFrequency, rms } from '@/lib/music';
import { prepareSensitiveFrame, segmentRms } from '@/lib/tuner-signal';
import { detectPitch } from '@/lib/yin';
import { detectMpm } from '@/lib/mpm';
import { createBrowserAudioContext, requestRawMicrophone, resumeBrowserAudio } from '@/lib/browser-audio';
import {
  createTunerWorkletCapture,
  type TunerCaptureFrame,
  type TunerWorkletCapture
} from '@/lib/tuner-capture';
import {
  createTunerConsensusClient,
  type TunerConsensusClient
} from '@/lib/tuner-consensus-client';
import {
  OneEuroFilter,
  PitchTracker,
  centsApart,
  chooseHarmonicCandidate,
  detectorRangeForSampleRate,
  type PitchCandidate,
  type PitchMode
} from '@/lib/pitch-engine';

const OPEN_LABELS=['G3','D4','A4','E5'];
const BUFFER_SIZE=8192;
const SHORT_BUFFER_SIZE=4096;
const FAST_BUFFER_SIZE=2048;
const ANALYSIS_MS=16;
const YIN_CONSENSUS_MS=112;
const MPM_CONSENSUS_MS=128;
const CONSENSUS_WORKER_MS=96;
const LONG_LOW_CADENCE_MS=32;
const LONG_HIGH_CADENCE_MS=64;
const UI_UPDATE_MS=33;
const WORKLET_MAX_FRAME_AGE_S=.18;
const WORKLET_STARTUP_WATCHDOG_MS=650;

type NativePermissionState='prompt'|'prompt-with-rationale'|'granted'|'denied';
type NativePermissionResult={microphone?:NativePermissionState}|undefined;
type NativePitchSample={frequency:number;rms:number;confidence:number;sampleRate:number;source:string;mode?:PitchMode};
type NativePitchError={message:string};
type NativePitchStartInfo={
  sampleRate:number;
  source:string;
  backend?:'oboe'|'audiorecord';
  framesPerBurst?:number;
  bufferCapacityFrames?:number;
  droppedFrames?:number;
  ringCapacityFrames?:number;
  oboeAvailable?:boolean;
  oboeFallbackErrorCode?:number;
};
type NativePitchPlugin={
  checkPermissions():Promise<NativePermissionResult>;
  requestPermissions(options:{permissions:string[]}):Promise<NativePermissionResult>;
  start():Promise<NativePitchStartInfo>;
  stop():Promise<void>;
  diagnostics():Promise<NativePitchStartInfo>;
  addListener(eventName:'pitch',listener:(sample:NativePitchSample)=>void):Promise<PluginListenerHandle>;
  addListener(eventName:'error',listener:(error:NativePitchError)=>void):Promise<PluginListenerHandle>;
  addListener(eventName:'backend',listener:(info:NativePitchStartInfo)=>void):Promise<PluginListenerHandle>;
};
const NativePitch=registerPlugin<NativePitchPlugin>('NativePitch');
function hasNativePitch(){return Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('NativePitch')}

function arcPoint(cx:number,cy:number,r:number,deg:number){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
function arcPath(r:number,a0:number,a1:number){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
function levelPercent(value:number){if(value<=0)return 0;const db=20*Math.log10(value);return Math.round(Math.max(0,Math.min(100,(db+60)/50*100)))}

export default function SoundTuner(){
  const [a4,setA4]=useState(440);
  const [running,setRunning]=useState(false);
  const [starting,setStarting]=useState(false);
  const [note,setNote]=useState('—');
  const [frequency,setFrequency]=useState<number|null>(null);
  const [cents,setCents]=useState<number|null>(null);
  const [needleCents,setNeedleCents]=useState<number|null>(null);
  const [micLevel,setMicLevel]=useState(0);
  const [status,setStatus]=useState('Ready');
  const [activeRef,setActiveRef]=useState<number|null>(null);
  const [loop,setLoop]=useState(false);
  const [detectRange,setDetectRange]=useState(()=>detectorRangeForSampleRate(48000));
  const [capturePath,setCapturePath]=useState<'Native Oboe'|'Native AudioRecord'|'AudioWorklet'|'Fallback'>('Fallback');
  const [dspPath,setDspPath]=useState<'Native'|'Worker'|'Main'>('Main');

  const ctxRef=useRef<AudioContext|null>(null);
  const analyserRef=useRef<AnalyserNode|null>(null);
  const shortAnalyserRef=useRef<AnalyserNode|null>(null);
  const fastAnalyserRef=useRef<AnalyserNode|null>(null);
  const workletCaptureRef=useRef<TunerWorkletCapture|null>(null);
  const workletShortReadyRef=useRef(false);
  const workletLongReadyRef=useRef(false);
  const workletFrameSeenRef=useRef(false);
  const workletSequenceRef=useRef(0);
  const workletWatchdogRef=useRef<number|null>(null);
  const consensusWorkerRef=useRef<TunerConsensusClient|null>(null);
  const consensusWorkerAtRef=useRef(0);
  const consensusSequenceRef=useRef(0);
  const consensusAppliedRef=useRef(0);
  const livePitchHintRef=useRef(0);
  const sourceRef=useRef<MediaStreamAudioSourceNode|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const trackCleanupRef=useRef<(()=>void)|null>(null);
  const contextCleanupRef=useRef<(()=>void)|null>(null);
  const bufferRef=useRef(new Float32Array(BUFFER_SIZE));
  const shortRawBufferRef=useRef(new Float32Array(SHORT_BUFFER_SIZE));
  const fastRawBufferRef=useRef(new Float32Array(FAST_BUFFER_SIZE));
  const analysisBufferRef=useRef(new Float32Array(BUFFER_SIZE));
  const shortBufferRef=useRef(new Float32Array(SHORT_BUFFER_SIZE));
  const fastBufferRef=useRef(new Float32Array(FAST_BUFFER_SIZE));
  const spectrumRef=useRef(new Float32Array(BUFFER_SIZE/2));
  const shortSpectrumRef=useRef(new Float32Array(SHORT_BUFFER_SIZE/2));
  const fastSpectrumRef=useRef(new Float32Array(FAST_BUFFER_SIZE/2));
  const rafRef=useRef(0),lastRef=useRef(0),captureStartedAtRef=useRef(0),uiAtRef=useRef(0);
  const captureSessionRef=useRef(0);
  const startingRef=useRef(false);
  const detectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const longFrequencyRef=useRef(0);
  const longClarityRef=useRef(0);
  const longAtRef=useRef(0);
  const shortDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const fastDetectorRef=useRef<ReturnType<typeof PitchDetector.forFloat32Array>|null>(null);
  const trackerRef=useRef(new PitchTracker());
  const needleFilterRef=useRef(new OneEuroFilter());
  const displayedMidiRef=useRef<number|null>(null);
  const detectRangeRef=useRef(detectorRangeForSampleRate(48000));
  const yinConsensusRef=useRef<PitchCandidate|null>(null);
  const mpmConsensusRef=useRef<PitchCandidate|null>(null);
  const yinConsensusAtRef=useRef(0);
  const mpmConsensusAtRef=useRef(48);
  const nativeListenerRef=useRef<PluginListenerHandle|null>(null),nativeErrorListenerRef=useRef<PluginListenerHandle|null>(null),nativeBackendListenerRef=useRef<PluginListenerHandle|null>(null),nativeActiveRef=useRef(false),a4Ref=useRef(a4);
  const audioRef=useRef<HTMLAudioElement|null>(null),oscRef=useRef<OscillatorNode|null>(null),gainRef=useRef<GainNode|null>(null);

  if(!detectorRef.current){
    const detector=PitchDetector.forFloat32Array(BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.22;
    detectorRef.current=detector;
  }
  if(!shortDetectorRef.current){
    const detector=PitchDetector.forFloat32Array(SHORT_BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.18;
    shortDetectorRef.current=detector;
  }
  if(!fastDetectorRef.current){
    const detector=PitchDetector.forFloat32Array(FAST_BUFFER_SIZE);
    detector.minVolumeAbsolute=0;
    detector.clarityThreshold=.16;
    fastDetectorRef.current=detector;
  }

  useEffect(()=>{
    a4Ref.current=a4;
    if(audioRef.current)audioRef.current.playbackRate=a4/440;
    if(oscRef.current&&ctxRef.current&&activeRef!==null){
      oscRef.current.frequency.setTargetAtTime(midiFrequency(activeRef,a4),ctxRef.current.currentTime,.015);
    }
  },[a4,activeRef]);

  function clearPitch(resetEngine=false){
    displayedMidiRef.current=null;
    if(resetEngine){
      trackerRef.current.reset();needleFilterRef.current.reset();
      yinConsensusRef.current=null;mpmConsensusRef.current=null;
      yinConsensusAtRef.current=0;mpmConsensusAtRef.current=48;
    }
    setNote('—');setFrequency(null);setCents(null);setNeedleCents(null);
  }

  function stopReference(){
    if(audioRef.current){audioRef.current.pause();audioRef.current.src='';audioRef.current=null}
    try{oscRef.current?.stop()}catch{}
    oscRef.current=null;gainRef.current=null;setActiveRef(null);
  }

  async function playReference(midi:number){
    stopReference();setActiveRef(midi);
    const label=OPEN_LABELS[OPEN_STRINGS.indexOf(midi as typeof OPEN_STRINGS[number])];
    const sample=`/assets/ear/${label}.mp3`,audio=new Audio(sample);
    audio.loop=loop;audio.volume=.72;audio.playbackRate=a4/440;audioRef.current=audio;
    try{
      await audio.play();
      setStatus(`Reference ${label} · ${midiFrequency(midi,a4).toFixed(2)} Hz`);
    }catch{
      const ctx=ctxRef.current||createBrowserAudioContext();
      if(!ctx){setStatus('Web Audio unavailable');return}
      ctxRef.current=ctx;await resumeBrowserAudio(ctx);
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.frequency.value=midiFrequency(midi,a4);osc.type='sine';gain.gain.value=.13;
      osc.connect(gain).connect(ctx.destination);osc.start();
      oscRef.current=osc;gainRef.current=gain;
      setStatus(`Reference ${label} · oscillator`);
      if(!loop)setTimeout(()=>{try{osc.stop()}catch{}setActiveRef(null)},2000);
    }
  }

  function applyTrackedPitch(rawFrequency:number,rawRms:number,clarity:number,mode:PitchMode,now=performance.now()){
    const tracked=trackerRef.current.accept({frequency:rawFrequency,clarity,rms:rawRms,mode,now});
    const due=now-uiAtRef.current>=UI_UPDATE_MS;

    if(tracked.frequency===null){
      if(!due)return;
      uiAtRef.current=now;
      setMicLevel(levelPercent(rawRms));
      if(tracked.state==='attack'){
        setStatus('Listening · note attack detected');
        return;
      }
      if(tracked.state==='candidate'){
        setStatus('Listening · confirming pitch');
        return;
      }
      if(tracked.state==='release'){
        setStatus('Listening · note releasing');
        return;
      }
      clearPitch(false);
      setStatus('Listening · no reliable pitch');
      return;
    }

    const mapped=noteFromFrequency(tracked.frequency,a4Ref.current);
    const noteChanged=displayedMidiRef.current!==mapped.midi;
    if(noteChanged){
      displayedMidiRef.current=mapped.midi;
      needleFilterRef.current.reset();
    }
    if(!due&&!noteChanged)return;

    uiAtRef.current=now;
    setMicLevel(levelPercent(rawRms));
    const filteredCents=needleFilterRef.current.filter(mapped.cents,now);
    const displayFrequency=mapped.target*Math.pow(2,filteredCents/1200);
    setNote(mapped.label);
    setFrequency(displayFrequency);
    setCents(filteredCents);
    setNeedleCents(filteredCents);

    if(tracked.state==='transition')setStatus(`Tracking ${mapped.label} · checking note change`);
    else if(tracked.held)setStatus(`Tracking ${mapped.label} · brief dropout held`);
    else setStatus(`${mode==='transient'?'Transient':'Pitch'} · ${mapped.label} · ${Math.round(tracked.confidence*100)}% confidence`);
  }

  function processCapturedFrames(
    ts:number,
    input:Float32Array|null,
    shortFrame:Float32Array|null,
    fastFrame:Float32Array,
    spectrum:Float32Array,
    metrics?:{prepared?:boolean;rms?:number;onset?:boolean}
  ){
    const ctx=ctxRef.current,longDetector=detectorRef.current,shortDetector=shortDetectorRef.current,fastDetector=fastDetectorRef.current;
    if(!ctx||!longDetector||!shortDetector||!fastDetector)return;

    const prepared=metrics?.prepared===true;
    const analysis=prepared&&input?input:analysisBufferRef.current;
    const shortAnalysis=prepared&&shortFrame?shortFrame:shortBufferRef.current;
    const fastAnalysis=prepared?fastFrame:fastBufferRef.current;
    if(!prepared){
      if(input)prepareSensitiveFrame(input,analysis);
      if(shortFrame)prepareSensitiveFrame(shortFrame,shortAnalysis);
      prepareSensitiveFrame(fastFrame,fastAnalysis);
    }
    const inputRms=metrics?.rms??rms(fastFrame);

    const [shortFrequency,shortClarity]=shortFrame
      ?shortDetector.findPitch(shortAnalysis,ctx.sampleRate)
      :[0,0];
    const [fastFrequency,fastClarity]=fastDetector.findPitch(fastAnalysis,ctx.sampleRate);

    const responsiveHint=fastFrequency>0?fastFrequency:shortFrequency;
    livePitchHintRef.current=responsiveHint;
    const longCadence=responsiveHint>350?LONG_HIGH_CADENCE_MS:LONG_LOW_CADENCE_MS;
    if(input&&ts-longAtRef.current>=longCadence){
      const [frequency,clarity]=longDetector.findPitch(analysis,ctx.sampleRate);
      longFrequencyRef.current=frequency>0?frequency:0;
      longClarityRef.current=clarity;
      longAtRef.current=ts;
    }
    const longFrequency=longFrequencyRef.current;
    const longClarity=longClarityRef.current;

    const worker=consensusWorkerRef.current;
    if(worker&&ts-consensusWorkerAtRef.current>=CONSENSUS_WORKER_MS){
      consensusWorkerAtRef.current=ts;
      const sequence=++consensusSequenceRef.current;
      const hint=shortFrequency>0?shortFrequency:fastFrequency>0?fastFrequency:longFrequency;
      worker.submit({
        sequence,
        sampleRate:ctx.sampleRate,
        minFrequency:detectRangeRef.current.min,
        maxFrequency:detectRangeRef.current.max,
        hintFrequency:hint,
        long:input?analysis:null,
        short:shortFrame?shortAnalysis:null,
        fast:fastAnalysis
      });
    }

    if(!worker&&ts-yinConsensusAtRef.current>=YIN_CONSENSUS_MS){
      const lowCandidate=longFrequency>0&&longFrequency<90;
      const consensusInput=lowCandidate?input:shortFrame;
      if(consensusInput){
        yinConsensusAtRef.current=ts;
        const prepared=lowCandidate?analysis:shortAnalysis;
        const range=detectRangeRef.current;
        const consensusMin=lowCandidate?range.min:Math.max(55,range.min);
        const independent=detectPitch(prepared,ctx.sampleRate,consensusMin,range.max);
        yinConsensusRef.current=independent
          ?{frequency:independent.frequency,clarity:independent.clarity,mode:'sustained'}
          :null;
      }
    }

    if(!worker&&ts-mpmConsensusAtRef.current>=MPM_CONSENSUS_MS){
      const hint=shortFrequency>0?shortFrequency:fastFrequency>0?fastFrequency:longFrequency;
      const lowMpm=hint>0&&hint<220;
      const mpmInput=lowMpm?shortFrame:fastFrame;
      if(hint>=70&&mpmInput){
        mpmConsensusAtRef.current=ts;
        const range=detectRangeRef.current;
        const prepared=lowMpm?shortAnalysis:fastAnalysis;
        const mpmMin=lowMpm?Math.max(70,range.min):Math.max(180,range.min);
        const independent=detectMpm(prepared,ctx.sampleRate,mpmMin,range.max);
        mpmConsensusRef.current=independent
          ?{frequency:independent.frequency,clarity:independent.clarity,mode:'sustained'}
          :null;
      }else if(hint<70){
        mpmConsensusRef.current=null;
      }
    }

    const onset=metrics?.onset??(()=>{
      const recentRms=segmentRms(fastFrame,FAST_BUFFER_SIZE-512,FAST_BUFFER_SIZE);
      const previousRms=segmentRms(fastFrame,0,FAST_BUFFER_SIZE-512);
      return recentRms>Math.max(previousRms*1.18,previousRms+0.00018);
    })();
    const useFast=fastFrequency>0&&(onset||fastFrequency>=500)&&fastClarity>=shortClarity*.86;
    const responsiveFrequency=useFast?fastFrequency:shortFrequency;
    const responsiveClarity=useFast?fastClarity:shortClarity;
    const fastShortAgree=
      fastFrequency>0&&shortFrequency>0&&
      centsApart(fastFrequency,shortFrequency)<=45;
    const suppressStaleLong=
      onset&&fastShortAgree&&responsiveFrequency>0&&
      longFrequency>0&&centsApart(longFrequency,responsiveFrequency)>80;
    const consensusCandidates=[yinConsensusRef.current,mpmConsensusRef.current]
      .filter((candidate):candidate is PitchCandidate=>candidate!==null)
      .filter(candidate=>
        !(onset&&fastShortAgree&&responsiveFrequency>0&&centsApart(candidate.frequency,responsiveFrequency)>80)
      );
    const picked=chooseHarmonicCandidate(
      {
        frequency:!suppressStaleLong&&longFrequency>0?longFrequency:0,
        clarity:!suppressStaleLong?longClarity:0,
        mode:'sustained'
      },
      {
        frequency:responsiveFrequency>0?responsiveFrequency:0,
        clarity:responsiveClarity,
        mode:onset?'transient':'sustained'
      },
      consensusCandidates,
      spectrum,
      ctx.sampleRate,
      detectRangeRef.current.min,
      detectRangeRef.current.max
    );
    const lowNeedsLongSupport=
      picked.frequency>0&&picked.frequency<80&&
      (suppressStaleLong||centsApart(longFrequency,picked.frequency)>45)&&
      !consensusCandidates.some(candidate=>centsApart(candidate.frequency,picked.frequency)<=45);
    applyTrackedPitch(
      lowNeedsLongSupport?0:picked.frequency,
      inputRms,
      lowNeedsLongSupport?0:picked.clarity,
      picked.mode,
      ts
    );
  }

  function spectrumForCurrentCapture(prefer:'fast'|'short'|'long'){
    const analyser=prefer==='long'?analyserRef.current:prefer==='short'?shortAnalyserRef.current:fastAnalyserRef.current;
    const target=prefer==='long'?spectrumRef.current:prefer==='short'?shortSpectrumRef.current:fastSpectrumRef.current;
    if(!analyser)return target;
    analyser.getFloatFrequencyData(target);
    return target;
  }

  function handleWorkletFrame(frame:TunerCaptureFrame){
    const ctx=ctxRef.current;
    if(!ctx)return;
    if(frame.sequence<=workletSequenceRef.current)return;
    workletSequenceRef.current=frame.sequence;
    if(frame.audioTime>0&&ctx.currentTime-frame.audioTime>WORKLET_MAX_FRAME_AGE_S)return;

    workletFrameSeenRef.current=true;
    if(workletWatchdogRef.current!==null){
      window.clearTimeout(workletWatchdogRef.current);
      workletWatchdogRef.current=null;
    }

    const now=performance.now();
    fastBufferRef.current.set(frame.fast);
    if(frame.short){
      shortBufferRef.current.set(frame.short);
      workletShortReadyRef.current=true;
    }
    if(frame.long){
      analysisBufferRef.current.set(frame.long);
      workletLongReadyRef.current=true;
    }
    const prefer=workletLongReadyRef.current?'long':workletShortReadyRef.current?'short':'fast';
    const spectrum=spectrumForCurrentCapture(prefer);
    processCapturedFrames(
      now,
      workletLongReadyRef.current?analysisBufferRef.current:null,
      workletShortReadyRef.current?shortBufferRef.current:null,
      fastBufferRef.current,
      spectrum,
      {prepared:true,rms:frame.rms,onset:frame.onset}
    );
  }

  function activateAnalyserFallback(message:string){
    workletCaptureRef.current?.stop();
    workletCaptureRef.current=null;
    if(workletWatchdogRef.current!==null){
      window.clearTimeout(workletWatchdogRef.current);
      workletWatchdogRef.current=null;
    }
    setCapturePath('Fallback');
    setStatus(message);
    if(!rafRef.current)rafRef.current=requestAnimationFrame(analyse);
  }

  function analyse(ts:number){
    const analyser=analyserRef.current,shortAnalyser=shortAnalyserRef.current,fastAnalyser=fastAnalyserRef.current;
    if(!analyser||!shortAnalyser||!fastAnalyser)return;
    if(ts-lastRef.current>=ANALYSIS_MS){
      lastRef.current=ts;
      analyser.getFloatTimeDomainData(bufferRef.current);
      shortAnalyser.getFloatTimeDomainData(shortRawBufferRef.current);
      fastAnalyser.getFloatTimeDomainData(fastRawBufferRef.current);
      const elapsed=Math.max(0,ts-captureStartedAtRef.current);
      const prefer=elapsed<70?'fast':elapsed<150?'short':'long';
      processCapturedFrames(
        ts,
        bufferRef.current,
        shortRawBufferRef.current,
        fastRawBufferRef.current,
        spectrumForCurrentCapture(prefer)
      );
    }
    rafRef.current=requestAnimationFrame(analyse);
  }

  function cleanupWebCaptureResources(stopTracks=true){
    cancelAnimationFrame(rafRef.current);rafRef.current=0;
    captureSessionRef.current++;
    trackCleanupRef.current?.();trackCleanupRef.current=null;
    contextCleanupRef.current?.();contextCleanupRef.current=null;
    if(workletWatchdogRef.current!==null){
      window.clearTimeout(workletWatchdogRef.current);
      workletWatchdogRef.current=null;
    }
    workletCaptureRef.current?.stop();workletCaptureRef.current=null;
    consensusWorkerRef.current?.stop();consensusWorkerRef.current=null;
    consensusWorkerAtRef.current=0;consensusSequenceRef.current=0;consensusAppliedRef.current=0;livePitchHintRef.current=0;
    workletShortReadyRef.current=false;workletLongReadyRef.current=false;
    workletFrameSeenRef.current=false;workletSequenceRef.current=0;
    try{
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      shortAnalyserRef.current?.disconnect();
      fastAnalyserRef.current?.disconnect();
    }catch{}
    if(stopTracks)streamRef.current?.getTracks().forEach(track=>track.stop());
    sourceRef.current=null;
    analyserRef.current=null;
    shortAnalyserRef.current=null;
    fastAnalyserRef.current=null;
    streamRef.current=null;
    longFrequencyRef.current=0;longClarityRef.current=0;longAtRef.current=0;uiAtRef.current=0;
  }

  function attachWebAudioContextLifecycle(ctx:AudioContext){
    contextCleanupRef.current?.();
    contextCleanupRef.current=null;

    const stateChanged=()=>{
      if(!streamRef.current)return;
      if(ctx.state==='suspended'){
        setStatus('Audio paused by browser · resume the tab to continue');
      }else if(ctx.state==='running'){
        const path=workletCaptureRef.current?'AudioWorklet':'analyser fallback';
        setStatus(`Listening · ${path} resumed`);
      }else if(ctx.state==='closed'){
        cleanupWebCaptureResources(true);
        startingRef.current=false;setStarting(false);
        setRunning(false);setMicLevel(0);clearPitch(true);
        setStatus('Browser audio context closed');
      }
    };
    const visibilityChanged=()=>{
      if(
        document.visibilityState==='visible' &&
        ctx.state==='suspended' &&
        streamRef.current
      ){
        void resumeBrowserAudio(ctx).then(()=>stateChanged());
      }
    };

    ctx.addEventListener('statechange',stateChanged);
    document.addEventListener('visibilitychange',visibilityChanged);
    contextCleanupRef.current=()=>{
      ctx.removeEventListener('statechange',stateChanged);
      document.removeEventListener('visibilitychange',visibilityChanged);
    };
  }

  function attachWebMicrophoneLifecycle(track:MediaStreamTrack|undefined){
    trackCleanupRef.current?.();
    trackCleanupRef.current=null;
    if(!track)return;

    const ended=()=>{
      cleanupWebCaptureResources(false);
      startingRef.current=false;setStarting(false);
      setRunning(false);setMicLevel(0);clearPitch(true);
      setStatus('Microphone disconnected');
    };
    const muted=()=>{
      if(streamRef.current)setStatus('Microphone temporarily muted');
    };
    const unmuted=()=>{
      if(streamRef.current)setStatus('Listening · microphone resumed');
    };

    track.addEventListener('ended',ended);
    track.addEventListener('mute',muted);
    track.addEventListener('unmute',unmuted);
    trackCleanupRef.current=()=>{
      track.removeEventListener('ended',ended);
      track.removeEventListener('mute',muted);
      track.removeEventListener('unmute',unmuted);
    };
  }

  function clearNativeListeners(){
    const pitch=nativeListenerRef.current;nativeListenerRef.current=null;
    const error=nativeErrorListenerRef.current;nativeErrorListenerRef.current=null;
    const backend=nativeBackendListenerRef.current;nativeBackendListenerRef.current=null;
    if(pitch)void pitch.remove();
    if(error)void error.remove();
    if(backend)void backend.remove();
  }

  function applyNativeBackendInfo(nativeInfo:NativePitchStartInfo,recovered=false){
    const nativeRange=detectorRangeForSampleRate(nativeInfo.sampleRate);
    const nativeCapturePath=nativeInfo.backend==='oboe'?'Native Oboe':'Native AudioRecord';
    detectRangeRef.current=nativeRange;
    setDetectRange(nativeRange);
    setCapturePath(nativeCapturePath);
    setDspPath('Native');

    const burst=nativeInfo.framesPerBurst&&nativeInfo.framesPerBurst>0
      ?` · burst ${nativeInfo.framesPerBurst}`
      :'';
    const fallback=nativeInfo.backend==='audiorecord'&&nativeInfo.oboeAvailable
      ?` · Oboe fallback ${nativeInfo.oboeFallbackErrorCode??'unknown'}`
      :'';
    setStatus(`${recovered?'Recovered':'Listening'} · ${nativeInfo.source} · ${nativeInfo.sampleRate} Hz${burst}${fallback}`);
  }

  async function ensureNativeMicrophonePermission(session:number){
    const current=await NativePitch.checkPermissions().catch(()=>undefined);
    if(session!==captureSessionRef.current)return false;
    if(current?.microphone==='granted')return true;

    // The Capacitor WebView permission path is already proven by Scale Practice.
    // Use it only to obtain Android RECORD_AUDIO permission, then immediately
    // release the temporary browser stream before native Oboe/AudioRecord starts.
    const permissionStream=await requestRawMicrophone();
    permissionStream.getTracks().forEach(track=>track.stop());
    if(session!==captureSessionRef.current)return false;

    const confirmed=await NativePitch.checkPermissions().catch(()=>undefined);
    if(confirmed?.microphone==='denied')throw new Error('microphone permission denied');
    return true;
  }

  async function startNativePitch(session:number){
    const permitted=await ensureNativeMicrophonePermission(session);
    if(!permitted)return;
    trackerRef.current.reset();needleFilterRef.current.reset();
    const listener=await NativePitch.addListener('pitch',sample=>{
      applyTrackedPitch(
        sample.frequency>0?sample.frequency:0,
        sample.rms,
        Math.max(0,Math.min(1,sample.confidence||0)),
        sample.mode??'sustained'
      );
    });
    const errorListener=await NativePitch.addListener('error',error=>{
      captureSessionRef.current++;
      startingRef.current=false;setStarting(false);
      nativeActiveRef.current=false;
      clearNativeListeners();
      setRunning(false);setMicLevel(0);clearPitch(true);
      setStatus(`Microphone stopped unexpectedly: ${error.message||'audio capture failed'}`);
    });
    const backendListener=await NativePitch.addListener('backend',nativeInfo=>{
      if(session!==captureSessionRef.current)return;
      trackerRef.current.reset();needleFilterRef.current.reset();
      clearPitch(false);setMicLevel(0);
      applyNativeBackendInfo(nativeInfo,true);
    });
    nativeListenerRef.current=listener;
    nativeErrorListenerRef.current=errorListener;
    nativeBackendListenerRef.current=backendListener;
    try{
      const nativeInfo=await NativePitch.start();
      if(session!==captureSessionRef.current){
        nativeListenerRef.current=null;nativeErrorListenerRef.current=null;nativeBackendListenerRef.current=null;
        await listener.remove();await errorListener.remove();await backendListener.remove();
        await NativePitch.stop().catch(()=>{});
        return;
      }
      nativeActiveRef.current=true;startingRef.current=false;setStarting(false);
      setRunning(true);clearPitch(false);setMicLevel(0);
      applyNativeBackendInfo(nativeInfo,false);
    }catch(err){
      nativeListenerRef.current=null;nativeErrorListenerRef.current=null;nativeBackendListenerRef.current=null;
      await listener.remove();await errorListener.remove();await backendListener.remove();throw err;
    }
  }

  async function start(){
    if(running||startingRef.current)return;
    startingRef.current=true;setStarting(true);stopReference();
    const session=++captureSessionRef.current;
    if(hasNativePitch()){
      try{await startNativePitch(session)}catch(err){
        if(session===captureSessionRef.current){
          startingRef.current=false;setStarting(false);
          setRunning(false);setMicLevel(0);clearPitch(true);
          setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`);
        }
      }
      if(session===captureSessionRef.current&&startingRef.current){
        startingRef.current=false;setStarting(false);
      }
      return;
    }
    try{
      const stream=await requestRawMicrophone();
      if(session!==captureSessionRef.current){stream.getTracks().forEach(track=>track.stop());return}
      const ctx=ctxRef.current||createBrowserAudioContext();
      if(!ctx){
        stream.getTracks().forEach(track=>track.stop());
        startingRef.current=false;setStarting(false);
        setStatus('Web Audio unavailable');
        return;
      }
      ctxRef.current=ctx;await resumeBrowserAudio(ctx);
      if(session!==captureSessionRef.current){stream.getTracks().forEach(track=>track.stop());return}
      if(ctx.state!=='running')throw new Error('Browser audio is suspended');
      attachWebAudioContextLifecycle(ctx);
      const browserRange=detectorRangeForSampleRate(ctx.sampleRate);
      detectRangeRef.current=browserRange;setDetectRange(browserRange);

      consensusWorkerRef.current=createTunerConsensusClient(
        result=>{
          if(result.sequence<consensusAppliedRef.current)return;
          const liveHint=livePitchHintRef.current;
          if(result.hintFrequency>0&&liveHint>0&&centsApart(result.hintFrequency,liveHint)>90)return;
          consensusAppliedRef.current=result.sequence;
          yinConsensusRef.current=result.yin
            ?{frequency:result.yin.frequency,clarity:result.yin.clarity,mode:'sustained'}
            :null;
          mpmConsensusRef.current=result.mpm
            ?{frequency:result.mpm.frequency,clarity:result.mpm.clarity,mode:'sustained'}
            :null;
        },
        ()=>{
          consensusWorkerRef.current?.stop();
          consensusWorkerRef.current=null;
          consensusWorkerAtRef.current=0;
          setDspPath('Main');
        }
      );
      setDspPath(consensusWorkerRef.current?'Worker':'Main');

      const source=ctx.createMediaStreamSource(stream);
      const analyser=ctx.createAnalyser(),shortAnalyser=ctx.createAnalyser(),fastAnalyser=ctx.createAnalyser();
      for(const [node,size] of [[analyser,BUFFER_SIZE],[shortAnalyser,SHORT_BUFFER_SIZE],[fastAnalyser,FAST_BUFFER_SIZE]] as const){
        node.fftSize=size;node.smoothingTimeConstant=0;node.minDecibels=-100;node.maxDecibels=-10;
        source.connect(node);
      }
      streamRef.current=stream;sourceRef.current=source;
      attachWebMicrophoneLifecycle(stream.getAudioTracks()[0]);
      analyserRef.current=analyser;shortAnalyserRef.current=shortAnalyser;fastAnalyserRef.current=fastAnalyser;
      trackerRef.current.reset();needleFilterRef.current.reset();
      workletShortReadyRef.current=false;workletLongReadyRef.current=false;
      workletFrameSeenRef.current=false;workletSequenceRef.current=0;
      consensusWorkerAtRef.current=0;consensusSequenceRef.current=0;consensusAppliedRef.current=0;
      if(workletWatchdogRef.current!==null){window.clearTimeout(workletWatchdogRef.current);workletWatchdogRef.current=null}
      longFrequencyRef.current=0;longClarityRef.current=0;longAtRef.current=0;uiAtRef.current=0;
      captureStartedAtRef.current=performance.now();
      clearPitch(false);setMicLevel(0);lastRef.current=0;

      const capture=await createTunerWorkletCapture(
        ctx,
        source,
        handleWorkletFrame,
        message=>activateAnalyserFallback(message+' Falling back to browser analyser.')
      );
      if(session!==captureSessionRef.current){
        capture?.stop();
        return;
      }
      if(capture){
        workletCaptureRef.current=capture;
        startingRef.current=false;setStarting(false);setRunning(true);
        setCapturePath('AudioWorklet');
        setStatus('Listening · AudioWorklet capture · harmonic-aware tracking');
        workletWatchdogRef.current=window.setTimeout(()=>{
          if(workletCaptureRef.current&&!workletFrameSeenRef.current){
            activateAnalyserFallback('AudioWorklet produced no frames · analyser fallback active');
          }
        },WORKLET_STARTUP_WATCHDOG_MS);
      }else{
        startingRef.current=false;setStarting(false);setRunning(true);
        setCapturePath('Fallback');
        setStatus('Listening · analyser fallback · harmonic-aware tracking');
        rafRef.current=requestAnimationFrame(analyse);
      }
    }catch(err){
      if(session===captureSessionRef.current)cleanupWebCaptureResources(true);
      startingRef.current=false;setStarting(false);
      setRunning(false);setMicLevel(0);clearPitch(true);
      setStatus(`Microphone unavailable: ${err instanceof Error?err.message:'permission denied'}`);
    }
  }

  function cancelStart(){
    if(!startingRef.current)return;
    captureSessionRef.current++;
    startingRef.current=false;setStarting(false);
    cleanupWebCaptureResources(true);
    clearNativeListeners();
    if(nativeActiveRef.current){nativeActiveRef.current=false;void NativePitch.stop().catch(()=>{})}
    setRunning(false);setMicLevel(0);clearPitch(true);
    setStatus('Microphone start cancelled');
  }

  function stop(){
    if(nativeActiveRef.current||nativeListenerRef.current||nativeErrorListenerRef.current||nativeBackendListenerRef.current){
      captureSessionRef.current++;
      startingRef.current=false;setStarting(false);
      nativeActiveRef.current=false;
      clearNativeListeners();
      void NativePitch.stop().catch(()=>{});
      longFrequencyRef.current=0;longClarityRef.current=0;longAtRef.current=0;uiAtRef.current=0;
    setRunning(false);setMicLevel(0);clearPitch(true);setStatus('Microphone stopped');return;
    }
    cleanupWebCaptureResources(true);
    startingRef.current=false;setStarting(false);
    setRunning(false);setMicLevel(0);clearPitch(true);setStatus('Microphone stopped');
  }

  useEffect(()=>()=>{cleanupWebCaptureResources(true);clearNativeListeners();if(nativeActiveRef.current)void NativePitch.stop().catch(()=>{});stopReference()},[]);

  const angle=Math.max(-50,Math.min(50,needleCents??0))/50*74;
  const inTune=cents!==null&&Math.abs(cents)<=3;
  const color=cents===null?'#94a3b8':inTune?'#0d9488':cents<0?'#d97706':'#dc2626';
  return <>
    <section className="card">
      <div className="card-head"><div><h2>Live pitch</h2></div><div className="pill"><i className="dot-live"/>{running?'Listening':starting?'Starting':'Ready'}</div></div>
      <div className="grid-2">
        <main className="tuner-main">
          <div className="control-label"><span>Microphone input</span><span>{running?`${micLevel}%`:'0%'}</span></div><div className="signal"><i style={{width:`${micLevel}%`}}/></div>
          <div className="gauge-wrap jelly-gauge">
            <svg className="gauge" viewBox="0 0 720 360" aria-label="Pitch deviation"><path className="gauge-base" d={arcPath(262,-74,74)}/><path className="gauge-good" d={arcPath(262,-5,5)}/><line className="needle" x1="360" y1="330" x2="360" y2="103" style={{transform:`rotate(${angle}deg)`,stroke:color}}/><circle className="needle-cap" cx="360" cy="330" r="12" style={{fill:color}}/></svg>
            <div className="tuner-readout"><div className="detected-note" style={{color}}>{note}</div><div className="frequency">{frequency?`${frequency.toFixed(2)} Hz`:'-- Hz'} {cents!==null&&<>· {cents>=0?'+':''}{cents.toFixed(1)} cents</>}</div><div className="hint">{!running?'Start the microphone':cents===null?'Play a steady tone':inTune?'In tune':cents<0?'Flat · tune higher':'Sharp · tune lower'}</div></div>
          </div>
          <div className="target-row"><span className="target-chip">{Math.ceil(detectRange.min)}–{Math.floor(detectRange.max)} Hz</span><span className="target-chip">{running?capturePath:'Auto capture'}</span><span className="target-chip">{running?'DSP '+dspPath:'DSP auto'}</span><span className="target-chip">Harmonic validated</span></div>
        </main>
        <aside className="side">
          <div className="control"><div className="control-label"><span>Reference A4</span><span>{a4.toFixed(1)} Hz</span></div><input className="range" type="range" min="415" max="466" step=".1" value={a4} onChange={e=>setA4(+e.target.value)}/><div className="seg three"><button onClick={()=>setA4(415)} className={a4===415?'active':''}>415</button><button onClick={()=>setA4(440)} className={a4===440?'active':''}>440</button><button onClick={()=>setA4(442)} className={a4===442?'active':''}>442</button></div></div>
          <div className="control"><div className="control-label"><span>Optional reference tones</span></div><div className="seg four">{OPEN_STRINGS.map((midi,i)=><button key={midi} className={activeRef===midi?'active':''} onClick={()=>activeRef===midi?stopReference():playReference(midi)}>{OPEN_LABELS[i]}</button>)}</div><label className="toggle" style={{marginTop:9}}><span>Loop reference</span><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);if(audioRef.current)audioRef.current.loop=e.target.checked}}/></label></div>
          <div className="control"><div className="status">{status}</div></div>
          <button className={`primary ${running||starting?'danger':''}`} onClick={running?stop:starting?cancelStart:start}>{running?'Stop microphone':starting?'Cancel starting':'Start tuning'}</button>
        </aside>
      </div>
    </section>
  </>;
}
