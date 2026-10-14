'use client';

import { useEffect, useRef, useState } from 'react';
import { PitchDetector } from 'pitchy';
import { createBrowserAudioContext, requestRawMicrophone, resumeBrowserAudio } from '@/lib/browser-audio';

type Result = { check:string; status:'PASS'|'FAIL'|'INFO'; detail:string };

export default function DesktopAudioCheck(){
  const [results,setResults]=useState<Result[]>([]);
  const [checkingMic,setCheckingMic]=useState(false);
  const [micLevel,setMicLevel]=useState(0);
  const ctxRef=useRef<AudioContext|null>(null);
  const micStopRef=useRef<(()=>void)|null>(null);

  function record(check:string,status:Result['status'],detail:string){
    setResults(current=>[{check,status,detail},...current.filter(r=>r.check!==check)].slice(0,12));
  }
  async function readyContext(){
    const ctx=ctxRef.current||createBrowserAudioContext();
    if(!ctx)throw new Error('Web Audio API unavailable');
    ctxRef.current=ctx;
    await resumeBrowserAudio(ctx);
    return ctx;
  }
  function stopMic(){
    micStopRef.current?.();
    micStopRef.current=null;
    setCheckingMic(false);
  }
  useEffect(()=>()=>{micStopRef.current?.();if(ctxRef.current)void ctxRef.current.close().catch(()=>{})},[]);

  async function speaker(){
    try{
      const ctx=await readyContext();
      const osc=ctx.createOscillator(),gain=ctx.createGain(),t=ctx.currentTime;
      osc.type='sine';osc.frequency.value=440;
      gain.gain.setValueAtTime(0,t);
      gain.gain.linearRampToValueAtTime(.12,t+.025);
      gain.gain.setValueAtTime(.12,t+.45);
      gain.gain.linearRampToValueAtTime(0,t+.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);osc.stop(t+.52);
      record('Speaker test','INFO','440 Hz beep scheduled. Confirm that you actually heard it.');
    }catch(e){record('Speaker test','FAIL',e instanceof Error?e.message:String(e))}
  }
  async function sample(name:string,url:string){
    try{
      // Unlock output synchronously from the click before async asset decoding.
      const ctx=await readyContext(),start=performance.now();
      const response=await fetch(url);
      if(!response.ok)throw new Error('Bundled asset HTTP '+response.status);
      const decoded=await ctx.decodeAudioData(await response.arrayBuffer());
      if(decoded.duration<=0||!Number.isFinite(decoded.duration))throw new Error('Decoder returned empty audio');
      const source=ctx.createBufferSource(),gain=ctx.createGain();
      source.buffer=decoded;gain.gain.value=.4;
      source.connect(gain).connect(ctx.destination);
      source.start();source.stop(ctx.currentTime+Math.min(decoded.duration,.8));
      record(name,'INFO',`Audio file decoded (${decoded.duration.toFixed(1)}s @ ${decoded.sampleRate} Hz, ${Math.round(performance.now()-start)}ms). This does NOT prove audible playback: confirm using the buttons below.`);
    }catch(e){record(name,'FAIL',e instanceof Error?e.message:String(e))}
  }

  async function microphone(){
    if(micStopRef.current){stopMic();return}
    let stream:MediaStream|null=null;
    try{
      const ctx=await readyContext();
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('getUserMedia unavailable (check secure origin and WebKitGTK media settings)');
      stream=await requestRawMicrophone();
      const source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser(),muted=ctx.createGain();
      analyser.fftSize=4096;analyser.smoothingTimeConstant=0;
      muted.gain.value=0;
      source.connect(analyser);analyser.connect(muted);muted.connect(ctx.destination);
      const samples=new Float32Array(4096),detector=PitchDetector.forFloat32Array(4096);
      let frame=0,peak=0,valid=0,frequency=0;
      let stopped=false;
      const track=stream.getAudioTracks()[0];
      const settings=track?.getSettings();
      const rate=ctx.sampleRate;
      const end=performance.now()+6000;
      const liveStream=stream;
      const finish=()=>{
        if(stopped)return;stopped=true;
        cancelAnimationFrame(frame);
        liveStream.getTracks().forEach(t=>t.stop());
        try{source.disconnect();analyser.disconnect();muted.disconnect()}catch{}
        const detail=`Peak level ${Math.round(peak*100)}%, pitch ${frequency?frequency.toFixed(1)+' Hz':'not detected'}, Web Audio ${rate} Hz, microphone track ${settings?.sampleRate??'unknown'} Hz.`;
        record('Microphone',frequency>0?'PASS':valid>0?'INFO':'FAIL',frequency>0?'Pitch detected. '+detail:valid>0?'Microphone captured sound, but no reliable note detected. '+detail:'No usable microphone samples. '+detail);
        micStopRef.current=null;
        setCheckingMic(false);
      };
      const sampleFrame=()=>{
        if(stopped)return;
        analyser.getFloatTimeDomainData(samples);
        let total=0;for(let i=0;i<samples.length;i++)total+=samples[i]*samples[i];
        const rms=Math.sqrt(total/samples.length);
        peak=Math.max(peak,rms);
        const level=Math.min(100,Math.round(rms*400));
        if(rms>.004)valid++;
        setMicLevel(level);
        if(rms>.004){
          const [hz,clarity]=detector.findPitch(samples,ctx.sampleRate);
          if(hz>0&&clarity>.6)frequency=hz;
        }
        if(performance.now()>=end){finish();return}
        frame=requestAnimationFrame(sampleFrame);
      };
      micStopRef.current=finish;
      setCheckingMic(true);
      record('Microphone','INFO','Recording no audio files. Make a sustained note for 6 seconds; only live pitch/level are measured.');
      frame=requestAnimationFrame(sampleFrame);
      stream=null;
    }catch(e){
      stream?.getTracks().forEach(t=>t.stop());
      setCheckingMic(false);
      record('Microphone','FAIL',e instanceof Error?e.message:String(e));
    }
  }
  function environment(){
    record('WebView environment','INFO',JSON.stringify({
      origin:location.origin,secure:window.isSecureContext,
      getUserMedia:!!navigator.mediaDevices?.getUserMedia,
      audioWorklet:typeof AudioWorkletNode!=='undefined',
      audioContext:!!(window.AudioContext||(window as typeof window&{webkitAudioContext?:typeof AudioContext}).webkitAudioContext),
      sampleRate:ctxRef.current?.sampleRate??'not opened',
      audioState:ctxRef.current?.state??'not opened',
      mp3Hint:document.createElement('audio').canPlayType('audio/mpeg'),
      wavHint:document.createElement('audio').canPlayType('audio/wav')
    }));
  }
  return <details className="card" style={{marginTop:20}}>
    <summary style={{cursor:'pointer',fontWeight:700}}>Desktop Audio Check · speaker, samples and microphone</summary>
    <p style={{margin:'12px 0'}}>Stop any running tuner before microphone testing. These checks use bundled files and do not send or save microphone audio.</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
      <button className="soft-btn" onClick={environment}>WebView capabilities</button>
      <button className="soft-btn" onClick={()=>void speaker()}>440 Hz speaker beep</button>
      <button className="soft-btn" onClick={()=>void sample('MP3 reference','/assets/ear/A4.mp3')}>MP3 reference</button>
      <button className="soft-btn" onClick={()=>void sample('WAV metronome','/assets/metronome/click.wav')}>WAV click</button>
      <button className="soft-btn" onClick={()=>void sample('WAV exercise','/assets/exercise/midi-69.wav')}>WAV exercise</button>
      <button className="soft-btn" onClick={()=>void sample('MP3 tanpura','/assets/tanpura/sa-pa_A.mp3')}>MP3 tanpura</button>
      <button className="soft-btn" onClick={()=>void microphone()}>{checkingMic?'Stop microphone test':'Microphone · 6s'}</button>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:10}}>
      <button className="soft-btn" onClick={()=>record('Audible playback','PASS','User confirmed audible speaker output on this desktop.')}>I heard the sound</button>
      <button className="soft-btn" onClick={()=>record('Audible playback','FAIL','Sound was NOT audible despite audio scheduling/decoding; check output routing, volume, GStreamer logs and OS devices.')}>Still silent</button>
    </div>
    {checkingMic&&<p aria-live="polite">Microphone level: {micLevel}%</p>}
    <div role="status" aria-live="polite" style={{marginTop:12}}>
      {results.map(x=><p key={x.check} style={{margin:'7px 0',overflowWrap:'anywhere'}}><b>{x.status} · {x.check}</b>: {x.detail}</p>)}
    </div>
  </details>;
}
