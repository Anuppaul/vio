(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    bpm: 120,
    beats: 4,
    subdivision: 1,
    sound: 'click',
    accent: true,
    flash: true,
    volume: .82,
    running: false,
    ctx: null,
    master: null,
    buffers: {},
    nextTime: 0,
    step: 0,
    timer: 0,
    visualQueue: [],
    tapTimes: [],
    raf: 0,
    pendulumSide: 0,
  };

  const soundFiles = {
    click: 'assets/metronome/click.wav',
    accent: 'assets/metronome/click-accent.wav',
    tablaNa: 'assets/metronome/tabla-na.wav',
    tablaTin: 'assets/metronome/tabla-tin.wav',
    tablaGe: 'assets/metronome/tabla-ge.wav',
    kick: 'assets/metronome/drum-kick.wav',
    snare: 'assets/metronome/drum-snare.wav',
    hat: 'assets/metronome/drum-hihat.wav',
  };

  const bpmNumber = $('bpmNumber');
  const bpmRange = $('bpmRange');
  const startBtn = $('startBtn');
  const tapBtn = $('tapBtn');
  const beatDots = $('beatDots');
  const beatReadout = $('beatReadout');
  const tempoName = $('tempoName');
  const surface = $('metronomeSurface');
  const pendulum = $('pendulum');
  const status = $('metroStatus');
  const volume = $('metroVolume');
  const volumeText = $('metroVolumeText');

  const TEMPOS = [
    [40, 59, 'Largo'], [60, 75, 'Adagio'], [76, 107, 'Andante'],
    [108, 119, 'Moderato'], [120, 155, 'Allegro'], [156, 175, 'Vivace'],
    [176, 300, 'Presto']
  ];

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function tempoLabel(bpm){
    const t = TEMPOS.find(([a,b]) => bpm >= a && bpm <= b);
    return t ? t[2] : 'Largo';
  }

  function updateTempoUI(){
    state.bpm = clamp(Math.round(state.bpm), 30, 300);
    bpmNumber.value = state.bpm;
    bpmRange.value = state.bpm;
    tempoName.textContent = tempoLabel(state.bpm);
    document.documentElement.style.setProperty('--beat-seconds', `${60/state.bpm}s`);
    if(state.running) status.textContent = `${state.bpm} BPM · ${state.beats} beat${state.beats===1?'':'s'} per bar`;
  }

  function renderDots(active=-1, downbeat=false){
    beatDots.innerHTML = '';
    for(let i=0;i<state.beats;i++){
      const dot = document.createElement('i');
      dot.className = 'beat-dot' + (i===active ? ' active' : '') + (i===active && downbeat ? ' downbeat' : '');
      dot.setAttribute('aria-hidden','true');
      beatDots.appendChild(dot);
    }
    beatReadout.textContent = active >= 0 ? `${active+1} / ${state.beats}` : `— / ${state.beats}`;
  }

  async function ensureAudio(){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) throw new Error('Web Audio is not supported by this browser.');
    if(!state.ctx){
      state.ctx = new AC({latencyHint:'interactive'});
      state.master = state.ctx.createGain();
      state.master.gain.value = state.volume;
      state.master.connect(state.ctx.destination);
    }
    if(state.ctx.state === 'suspended') await state.ctx.resume();
    return state.ctx;
  }

  async function preloadSounds(){
    try{
      const ctx = await ensureAudio();
      const entries = Object.entries(soundFiles);
      await Promise.all(entries.map(async ([key,url]) => {
        try{
          const res = await fetch(url, {cache:'force-cache'});
          if(!res.ok) throw new Error(String(res.status));
          const data = await res.arrayBuffer();
          state.buffers[key] = await ctx.decodeAudioData(data.slice(0));
        }catch(err){ console.warn('Could not load', url, err); }
      }));
      status.textContent = 'Ready · loud click loaded';
    }catch(err){ status.textContent = err.message; }
  }

  function synthClick(when, accent=false, level=1){
    const ctx = state.ctx;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    const noise = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate*.035), ctx.sampleRate);
    const arr = nbuf.getChannelData(0);
    for(let i=0;i<arr.length;i++) arr[i]=(Math.random()*2-1)*Math.exp(-i/(ctx.sampleRate*.007));
    noise.buffer = nbuf;
    osc.type='square';
    osc.frequency.value = accent ? 2600 : 1850;
    gain.gain.setValueAtTime(.0001, when);
    gain.gain.exponentialRampToValueAtTime(.55*level, when+.001);
    gain.gain.exponentialRampToValueAtTime(.0001, when+.045);
    osc.connect(gain); noise.connect(gain); gain.connect(state.master);
    osc.start(when); noise.start(when); osc.stop(when+.05); noise.stop(when+.05);
  }

  function playBuffer(key, when, gainValue=1){
    const buffer = state.buffers[key];
    if(!buffer) return false;
    const src = state.ctx.createBufferSource();
    const gain = state.ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = gainValue;
    src.connect(gain).connect(state.master);
    src.start(when);
    return true;
  }

  function scheduleSound(when, beat, sub){
    const isMain = sub === 0;
    const isDown = beat === 0 && isMain;
    const subGain = isMain ? 1 : .36;

    if(state.sound === 'click'){
      const key = isDown && state.accent ? 'accent' : 'click';
      const gain = isDown && state.accent ? 1.08 : subGain;
      if(!playBuffer(key, when, gain)) synthClick(when, isDown && state.accent, gain);
      return;
    }

    if(state.sound === 'tabla'){
      if(isMain){
        if(isDown){
          const ok = playBuffer('tablaGe', when, state.accent ? 1.05 : .88);
          playBuffer('tablaNa', when+.012, state.accent ? .58 : .48);
          if(!ok) synthClick(when, true, .72);
        }else{
          const key = beat % 2 ? 'tablaNa' : 'tablaTin';
          if(!playBuffer(key, when, .82)) synthClick(when, false, .55);
        }
      }else{
        playBuffer('tablaTin', when, .28);
      }
      return;
    }

    if(state.sound === 'drum'){
      if(isMain){
        if(isDown || beat % 2 === 0) playBuffer('kick', when, isDown && state.accent ? 1.05 : .85);
        else playBuffer('snare', when, .82);
        if(isDown && state.accent) playBuffer('hat', when, .52);
      }else playBuffer('hat', when, .35);
      return;
    }
  }

  function scheduleStep(step, when){
    const subdivisions = state.subdivision;
    const beat = Math.floor(step / subdivisions) % state.beats;
    const sub = step % subdivisions;
    const isDown = beat===0 && sub===0;
    scheduleSound(when, beat, sub);
    state.visualQueue.push({time:when, beat, sub, downbeat:isDown});
  }

  function scheduler(){
    if(!state.running || !state.ctx) return;
    const horizon = state.ctx.currentTime + (document.hidden ? .8 : .16);
    const secPerStep = (60/state.bpm) / state.subdivision;
    while(state.nextTime < horizon){
      scheduleStep(state.step, state.nextTime);
      state.nextTime += secPerStep;
      state.step = (state.step + 1) % (state.beats * state.subdivision);
    }
    state.timer = window.setTimeout(scheduler, document.hidden ? 120 : 25);
  }

  function animate(){
    if(!state.ctx){ state.raf=requestAnimationFrame(animate); return; }
    const now = state.ctx.currentTime;
    while(state.visualQueue.length && state.visualQueue[0].time <= now + .012){
      const event = state.visualQueue.shift();
      if(event.sub===0) pulseBeat(event.beat,event.downbeat);
      else pulseSubdivision();
    }
    state.raf=requestAnimationFrame(animate);
  }

  function pulseBeat(beat, downbeat){
    renderDots(beat, downbeat);
    surface.classList.remove('pulse','downbeat-pulse');
    void surface.offsetWidth;
    surface.classList.add(downbeat?'downbeat-pulse':'pulse');
    state.pendulumSide = state.pendulumSide ? 0 : 1;
    pendulum.dataset.side = String(state.pendulumSide);
    if(state.flash){
      document.body.classList.remove('metro-flash','metro-downbeat');
      void document.body.offsetWidth;
      document.body.classList.add(downbeat?'metro-downbeat':'metro-flash');
    }
  }

  function pulseSubdivision(){
    surface.classList.remove('sub-pulse'); void surface.offsetWidth; surface.classList.add('sub-pulse');
  }

  async function start(){
    await ensureAudio();
    state.running = true;
    state.step = 0;
    state.pendulumSide = 0;
    pendulum.dataset.side = '0';
    state.visualQueue.length = 0;
    state.nextTime = state.ctx.currentTime + .08;
    startBtn.textContent='Stop';
    startBtn.classList.add('running');
    surface.classList.add('running');
    status.textContent=`${state.bpm} BPM · ${state.beats} beats per bar`;
    scheduler();
  }

  function stop(){
    state.running = false;
    clearTimeout(state.timer);
    state.timer=0;
    state.visualQueue.length=0;
    startBtn.textContent='Start';
    startBtn.classList.remove('running');
    surface.classList.remove('running','pulse','sub-pulse','downbeat-pulse');
    document.body.classList.remove('metro-flash','metro-downbeat');
    renderDots(-1,false);
    status.textContent='Stopped';
  }

  function setBpm(v){ state.bpm=clamp(Number(v)||120,30,300); updateTempoUI(); }
  function setBeats(n){ state.beats=n; state.step=0; renderDots(-1,false); setActive('[data-beats]', String(n)); }
  function setSubdivision(n){ state.subdivision=n; state.step=0; setActive('[data-subdivision]', String(n)); }
  function setSound(s){ state.sound=s; setActive('[data-sound]',s); $('soundName').textContent = s==='click'?'Loud Click':s==='tabla'?'Tabla':'Drum Kit'; }
  function setActive(selector,value){ document.querySelectorAll(selector).forEach(el=>el.classList.toggle('active',el.dataset.beats===value||el.dataset.subdivision===value||el.dataset.sound===value)); }

  function tapTempo(){
    const now = performance.now();
    if(state.tapTimes.length && now-state.tapTimes.at(-1)>2000) state.tapTimes=[];
    state.tapTimes.push(now);
    if(state.tapTimes.length>8) state.tapTimes.shift();
    tapBtn.classList.remove('tap-hit'); void tapBtn.offsetWidth; tapBtn.classList.add('tap-hit');
    if(state.tapTimes.length>=2){
      const intervals=[];
      for(let i=1;i<state.tapTimes.length;i++) intervals.push(state.tapTimes[i]-state.tapTimes[i-1]);
      const sorted=[...intervals].sort((a,b)=>a-b);
      const median=sorted[Math.floor(sorted.length/2)];
      const filtered=intervals.filter(v=>Math.abs(v-median)<median*.28);
      const used=filtered.length?filtered:intervals;
      const avg=used.reduce((a,b)=>a+b,0)/used.length;
      setBpm(60000/avg);
      status.textContent=`Tap tempo · ${state.bpm} BPM`;
    }else status.textContent='Tap again…';
  }

  startBtn.addEventListener('click',()=> state.running ? stop() : start().catch(e=>status.textContent=e.message));
  tapBtn.addEventListener('click',tapTempo);
  bpmNumber.addEventListener('change',e=>setBpm(e.target.value));
  bpmNumber.addEventListener('input',e=>setBpm(e.target.value));
  bpmRange.addEventListener('input',e=>setBpm(e.target.value));
  $('minusBtn').addEventListener('click',()=>setBpm(state.bpm-1));
  $('plusBtn').addEventListener('click',()=>setBpm(state.bpm+1));
  document.querySelectorAll('[data-tempo]').forEach(b=>b.addEventListener('click',()=>setBpm(b.dataset.tempo)));
  document.querySelectorAll('[data-beats]').forEach(b=>b.addEventListener('click',()=>setBeats(Number(b.dataset.beats))));
  document.querySelectorAll('[data-subdivision]').forEach(b=>b.addEventListener('click',()=>setSubdivision(Number(b.dataset.subdivision))));
  document.querySelectorAll('[data-sound]').forEach(b=>b.addEventListener('click',()=>setSound(b.dataset.sound)));
  $('accentToggle').addEventListener('change',e=>state.accent=e.target.checked);
  $('flashToggle').addEventListener('change',e=>state.flash=e.target.checked);
  volume.addEventListener('input',e=>{
    state.volume=Number(e.target.value)/100;
    volumeText.textContent=`${e.target.value}%`;
    if(state.master) state.master.gain.setTargetAtTime(state.volume,state.ctx.currentTime,.015);
  });
  document.addEventListener('keydown',e=>{
    if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName) && e.code==='Space') return;
    if(e.code==='Space'){ e.preventDefault(); state.running?stop():start().catch(()=>{}); }
    else if(e.code==='ArrowUp'){ e.preventDefault(); setBpm(state.bpm+(e.shiftKey?5:1)); }
    else if(e.code==='ArrowDown'){ e.preventDefault(); setBpm(state.bpm-(e.shiftKey?5:1)); }
    else if(e.key.toLowerCase()==='t' && !e.ctrlKey && !e.metaKey){ tapTempo(); }
  });
  window.addEventListener('pagehide',stop);

  updateTempoUI(); renderDots(-1,false); setBeats(4); setSubdivision(1); setSound('click');
  state.raf=requestAnimationFrame(animate);
  preloadSounds();
})();
