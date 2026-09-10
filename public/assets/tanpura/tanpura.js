(() => {
  'use strict';
  const map=window.TANPURA_ASSETS||{'sa-pa':{},'sa-ma':{}};
  const $=id=>document.getElementById(id), status=$('tanpuraStatus'), now=$('tanpuraNow'), playBtn=$('tanpuraPlay'), vol=$('tanpuraVolume'), volText=$('tanpuraVolumeText');
  const semitone={C:0,'C#':1,D:2,'D#':3,E:4,F:5,'F#':6,G:7,'G#':8,A:9,'A#':10,B:11};
  let state={pattern:'sa-pa',key:'C',volume:.6,playing:false,audio:null,ctx:null,synthNodes:[],synthMaster:null,timer:0};

  function label(){return `${state.key} · ${state.pattern==='sa-pa'?'SA PA':'SA MA'}`}
  function setControls(){
    document.querySelectorAll('.patterns button').forEach(b=>b.classList.toggle('active',b.dataset.pattern===state.pattern));
    document.querySelectorAll('.keys button').forEach(b=>b.classList.toggle('active',b.dataset.key===state.key));
    now.textContent=label();playBtn.textContent=state.playing?'■ STOP':'▶ PLAY';playBtn.classList.toggle('stop',state.playing);
  }
  function stopAudio(){if(state.audio){try{state.audio.pause();state.audio.currentTime=0;state.audio.src=''}catch(_){}state.audio=null}}
  function stopSynth(){if(state.timer){clearInterval(state.timer);state.timer=0}state.synthMaster=null;for(const n of state.synthNodes){try{n.stop&&n.stop()}catch(_){}try{n.disconnect&&n.disconnect()}catch(_){}}state.synthNodes=[]}
  function stop(update=true){stopAudio();stopSynth();state.playing=false;setControls();if(update)status.textContent='Stopped'}

  function localUrl(){
    const p=map[state.pattern]||{};return p[state.key]||p[state.key.replace('#','s')]||null;
  }
  async function playLocal(url){
    const a=new Audio();state.audio=a;a.src=url;a.loop=true;a.volume=state.volume;a.preload='auto';
    try{await a.play();status.textContent=`Playing local Tanpura MP3 · ${label()}`;return true}catch(_){state.audio=null;return false}
  }
  function keyFreq(key){return 130.81278265*Math.pow(2,semitone[key]/12)} // C3 base
  function pluck(ctx,dest,freq,when,amp=.16){
    const osc=ctx.createOscillator(), gain=ctx.createGain(), filt=ctx.createBiquadFilter();osc.type='sawtooth';osc.frequency.setValueAtTime(freq,when);filt.type='lowpass';filt.frequency.setValueAtTime(Math.min(4200,freq*10),when);filt.Q.value=.7;
    gain.gain.setValueAtTime(.0001,when);gain.gain.exponentialRampToValueAtTime(Math.max(.001,amp),when+.015);gain.gain.exponentialRampToValueAtTime(.0001,when+2.8);osc.connect(filt).connect(gain).connect(dest);osc.start(when);osc.stop(when+3);state.synthNodes.push(osc,gain,filt);
  }
  function startSynth(){
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC){status.textContent='No local MP3 and Web Audio is unavailable.';return false}state.ctx=state.ctx||new AC();if(state.ctx.state==='suspended')state.ctx.resume();
    const ctx=state.ctx, master=ctx.createGain(), verb=ctx.createConvolver();master.gain.value=state.volume;master.connect(ctx.destination);state.synthMaster=master;state.synthNodes.push(master);
    const sa=keyFreq(state.key), other=sa*Math.pow(2,(state.pattern==='sa-pa'?7:5)/12);
    const cycle=()=>{const t=ctx.currentTime+.03;pluck(ctx,master,other,t,.14);pluck(ctx,master,sa,t+.72,.17);pluck(ctx,master,sa*2,t+1.44,.12);pluck(ctx,master,sa,t+2.16,.16)};
    cycle();state.timer=setInterval(cycle,2880);status.textContent=`Local MP3 not mapped; synthesized ${label()} fallback is playing`;return true;
  }
  async function start(){
    stop(false);state.playing=true;setControls();const u=localUrl();let ok=false;if(u)ok=await playLocal(u);if(!ok)startSynth();
  }
  function restartIfPlaying(){if(state.playing)start();else setControls()}
  document.querySelectorAll('.patterns button').forEach(b=>b.addEventListener('click',()=>{state.pattern=b.dataset.pattern;restartIfPlaying()}));
  document.querySelectorAll('.keys button').forEach(b=>b.addEventListener('click',()=>{state.key=b.dataset.key;restartIfPlaying()}));
  playBtn.addEventListener('click',()=>state.playing?stop():start());
  vol.addEventListener('input',e=>{state.volume=Number(e.target.value)/100;volText.textContent=`${e.target.value}%`;if(state.audio)state.audio.volume=state.volume;if(state.synthMaster)state.synthMaster.gain.value=state.volume});
  window.addEventListener('pagehide',()=>stop(false));setControls();
})();
