(() => {
  'use strict';
  const Core = window.TunerCore;
  if (!Core) throw new Error('TunerCore failed to load');
  const $ = id => document.getElementById(id);

  const pitchSlider=$('referencePitch'), pitchText=$('pitchText'), noteEl=$('detectedNote'), stringEl=$('stringLabel'), freqEl=$('detectedFreq'), centsEl=$('detectedCents'), hintEl=$('tuneHint'), status=$('status'), startBtn=$('startBtn'), stopBtn=$('stopBtn'), loopPlay=$('loopPlay'), listeningPill=$('listeningPill'), listeningText=$('listeningText'), qualityBar=$('qualityBar'), needleGroup=$('needleGroup'), needleLine=$('needleLine'), needleCap=$('needleCap');
  const bases=['./assets/ear/','./assets/violin/'];

  let refPitch=440, audioCtx=null, analyser=null, stream=null, source=null, running=false, analyseRAF=0, needleRAF=0, audio=null, activeRef=null;
  let buffer=null, lastAnalysis=0, noPitchCount=0, lockKey=null, pendingKey=null, pendingCount=0, centsHistory=[], freqHistory=[];
  let shownCents=0, targetAngle=0, currentAngle=0, currentColor='#64748b';

  // Low-latency tuning: a 2048-sample window still contains enough cycles for G3
  // while cutting the capture window roughly in half versus the previous 4096 size.
  const IN_TUNE=3.0, ANALYSIS_MS=24, RELEASE_FRAMES=5, INSTANT_LOCK_CLARITY=.88;

  function arcPoint(cx,cy,r,deg){const a=deg*Math.PI/180;return [cx+r*Math.sin(a),cy-r*Math.cos(a)]}
  function arcPath(r,a0,a1){const [x0,y0]=arcPoint(360,330,r,a0),[x1,y1]=arcPoint(360,330,r,a1);return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
  function buildGauge(){
    $('baseArc').setAttribute('d',arcPath(262,-74,74)); $('goodArc').setAttribute('d',arcPath(262,-5,5));
    const layer=$('tickLayer'), ns='http://www.w3.org/2000/svg';
    for(let cents=-50;cents<=50;cents+=2){
      const deg=cents/50*74, major=cents%10===0, center=cents===0, ro=248, ri=center?219:major?225:234;
      const [x1,y1]=arcPoint(360,330,ri,deg),[x2,y2]=arcPoint(360,330,ro,deg);const line=document.createElementNS(ns,'line');line.setAttribute('x1',x1);line.setAttribute('y1',y1);line.setAttribute('x2',x2);line.setAttribute('y2',y2);line.setAttribute('class','tick'+(major?' major':'')+(center?' center':''));layer.appendChild(line);
      if(cents%25===0){const [tx,ty]=arcPoint(360,330,202,deg),text=document.createElementNS(ns,'text');text.setAttribute('x',tx);text.setAttribute('y',ty+4);text.setAttribute('text-anchor','middle');text.textContent=cents>0?`+${cents}`:`${cents}`;layer.appendChild(text)}
    }
  }
  buildGauge();

  function midiHz(midi){return Core.midiFrequency(midi,refPitch)}
  function updateReferenceLabels(){document.querySelectorAll('.ref-btn').forEach(b=>{const m=Number(b.dataset.midi);b.querySelector('[data-hz]').textContent=`${midiHz(m).toFixed(2)} Hz`})}
  updateReferenceLabels();

  function setPresetActive(){document.querySelectorAll('.preset').forEach(b=>b.classList.toggle('active',Math.abs(Number(b.dataset.pitch)-refPitch)<.05))}
  function setLive(live,text){listeningPill.classList.toggle('live',live);listeningText.textContent=text}
  function setQuality(clarity=0,rms=0){const q=Math.max(0,Math.min(1,((clarity-.68)/.30)*.82+Math.min(1,rms/.06)*.18));qualityBar.style.setProperty('--quality',`${(q*100).toFixed(0)}%`)}

  function asciiName(midi){return Core.asciiNoteName(midi)}
  function naturalCandidates(midi){
    const sharp=asciiName(midi),oct=Math.floor(midi/12)-1,pc=((midi%12)+12)%12,out=[];const flat=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'][pc]+oct,stem=[];
    if(!sharp.includes('#'))stem.push(sharp);else{const l=sharp[0];stem.push(`${l}s${oct}`,`${l}sharp${oct}`,`${l}-sharp${oct}`,sharp,flat,`${flat[0]}flat${oct}`,`${flat[0]}-flat${oct}`)}
    for(const b of bases)for(const s of stem){const u=b+encodeURIComponent(s)+'.mp3';if(!out.includes(u))out.push(u)}return out;
  }
  function stopReference(){if(audio){try{audio.pause();audio.removeAttribute('src');audio.load()}catch(_){}audio=null}activeRef=null;document.querySelectorAll('.ref-btn').forEach(b=>b.classList.remove('active'))}
  function beepReference(midi){
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;if(!audioCtx)audioCtx=new AC();if(audioCtx.state==='suspended')audioCtx.resume();
    const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();osc.type='sine';osc.frequency.value=midiHz(midi);gain.gain.setValueAtTime(.0001,audioCtx.currentTime);gain.gain.exponentialRampToValueAtTime(.13,audioCtx.currentTime+.018);gain.gain.exponentialRampToValueAtTime(.0001,audioCtx.currentTime+(loopPlay.checked?7.5:2.1));osc.connect(gain).connect(audioCtx.destination);osc.start();osc.stop(audioCtx.currentTime+(loopPlay.checked?7.6:2.2));
  }
  function playReference(midi,button){
    stopReference();activeRef=midi;button.classList.add('active');const urls=naturalCandidates(midi);let i=0;
    const attempt=()=>{if(activeRef!==midi)return;if(i>=urls.length){status.textContent=`Local ${Core.noteName(midi)} sample not found; using clean oscillator fallback.`;beepReference(midi);return}
      const a=new Audio();audio=a;a.preload='auto';a.loop=loopPlay.checked;a.volume=.72;a.playbackRate=refPitch/440;
      const fail=()=>{if(audio===a){i++;attempt()}};a.addEventListener('canplaythrough',async()=>{if(activeRef!==midi)return;try{await a.play();status.textContent=`Reference ${Core.noteName(midi)} · ${midiHz(midi).toFixed(2)} Hz`}catch(_){fail()}},{once:true});a.addEventListener('error',fail,{once:true});a.addEventListener('ended',()=>{if(!loopPlay.checked){stopReference();status.textContent=running?'Listening…':'Ready'}});a.src=urls[i];a.load();
    };attempt();
  }

  function clearTargetChips(){document.querySelectorAll('.target-chip').forEach(c=>c.classList.remove('active'))}
  function activateTarget(midi){clearTargetChips();const el=document.querySelector(`.target-chip[data-midi="${midi}"]`);if(el)el.classList.add('active')}
  function resetReading(message='Start tuning, then play G, D, A or E'){
    lockKey=pendingKey=null;pendingCount=0;centsHistory=[];freqHistory=[];shownCents=0;targetAngle=0;noPitchCount=0;noteEl.textContent='—';noteEl.style.color='#94a3b8';stringEl.textContent=running?'Listening for an open string':'Waiting for microphone';freqEl.textContent='-- Hz';centsEl.textContent='-- cents';hintEl.textContent=message;needleLine.style.stroke=needleCap.style.fill='#64748b';currentColor='#64748b';clearTargetChips();setQuality(0,0)
  }

  function stableLock(candidate,clarity){
    const key=candidate ? `v:${candidate.midi}` : null;if(!key)return null;
    if(lockKey===key)return candidate;

    // First clean note should appear immediately. For a weaker/noisier change,
    // require just one confirming frame to avoid random note flicker.
    if(lockKey===null||clarity>=INSTANT_LOCK_CLARITY){
      lockKey=key;pendingKey=null;pendingCount=0;centsHistory=[];freqHistory=[];shownCents=candidate.cents;return candidate;
    }
    if(pendingKey===key)pendingCount++;else{pendingKey=key;pendingCount=1}
    if(pendingCount>=2){lockKey=key;pendingKey=null;pendingCount=0;centsHistory=[];freqHistory=[];shownCents=candidate.cents;return candidate}
    return null;
  }

  function classify(result){
    // Prefer a harmonic-aware open-string match. If the played pitch is not near
    // any open-string harmonic, show the true nearest chromatic note instead of lying.
    const violin=Core.matchViolinString(result.frequency,refPitch,72);
    const candidate=violin||Core.nearestChromatic(result.frequency,refPitch);
    return {candidate,isViolin:!!violin};
  }

  function showReading(result){
    noPitchCount=0;setQuality(result.clarity,result.rms);const {candidate,isViolin}=classify(result),accepted=stableLock(candidate,result.clarity);
    if(!accepted)return;

    let c=accepted;if(`v:${c.midi}`!==lockKey)return;
    const oldMedian=centsHistory.length?Core.median(centsHistory):c.cents;if(centsHistory.length&&Math.abs(c.cents-oldMedian)>18){centsHistory=[c.cents];shownCents=c.cents}else{centsHistory.push(c.cents);if(centsHistory.length>2)centsHistory.shift()}freqHistory.push(c.correctedFrequency);if(freqHistory.length>2)freqHistory.shift();
    const medCents=Core.median(centsHistory),medFreq=Core.median(freqHistory),delta=Math.abs(medCents-shownCents),alpha=delta>5?.85:.68;shownCents=shownCents*(1-alpha)+medCents*alpha;
    const clipped=Math.max(-50,Math.min(50,shownCents));targetAngle=clipped/50*74;
    const abs=Math.abs(shownCents);let color,msg;
    if(abs<=IN_TUNE){color='#0d9488';msg='In tune'}else if(shownCents<0){color='#d97706';msg='Flat · tune higher'}else{color='#dc2626';msg='Sharp · tune lower'}
    currentColor=color;needleLine.style.stroke=color;needleCap.style.fill=color;noteEl.style.color=color;
    noteEl.textContent=c.note;stringEl.textContent=isViolin?`${c.note} open string${c.harmonic>1?` · harmonic ${c.harmonic} corrected`:''}`:'Chromatic pitch';freqEl.textContent=`${medFreq.toFixed(2)} Hz`;centsEl.textContent=`${shownCents>=0?'+':''}${shownCents.toFixed(1)} cents`;hintEl.textContent=msg;
    if(isViolin)activateTarget(c.midi);else clearTargetChips();
  }

  function releaseReading(){
    noPitchCount++;setQuality(0,0);if(noPitchCount<RELEASE_FRAMES)return;targetAngle=0;lockKey=pendingKey=null;pendingCount=0;centsHistory=[];freqHistory=[];noteEl.textContent='—';noteEl.style.color='#94a3b8';stringEl.textContent='Listening for an open string';freqEl.textContent='-- Hz';centsEl.textContent='-- cents';hintEl.textContent='Play one violin string at a time';needleLine.style.stroke=needleCap.style.fill='#64748b';clearTargetChips();
  }

  function animateNeedle(){
    // Fast interpolation keeps motion stable without visibly trailing the live pitch.
    currentAngle += (targetAngle-currentAngle)*.32;if(Math.abs(targetAngle-currentAngle)<.03)currentAngle=targetAngle;needleGroup.style.transform=`rotate(${currentAngle.toFixed(3)}deg)`;needleRAF=requestAnimationFrame(animateNeedle)
  }
  animateNeedle();

  function analyse(ts){
    if(!running||!analyser)return;if(ts-lastAnalysis>=ANALYSIS_MS){lastAnalysis=ts;analyser.getFloatTimeDomainData(buffer);const result=Core.detectPitch(buffer,audioCtx.sampleRate,{minFreq:170,maxFreq:1500,rmsFloor:.0055,clarityFloor:.70,peakRatio:.88});if(result)showReading(result);else releaseReading()}analyseRAF=requestAnimationFrame(analyse)
  }

  async function start(){
    if(running)return;stopReference();
    if(!navigator.mediaDevices?.getUserMedia){status.textContent='Microphone API is unavailable. Open this page on HTTPS or http://localhost.';return}
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      const AC=window.AudioContext||window.webkitAudioContext;audioCtx=audioCtx||new AC({latencyHint:'interactive'});if(audioCtx.state==='suspended')await audioCtx.resume();source=audioCtx.createMediaStreamSource(stream);analyser=audioCtx.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=0;source.connect(analyser);buffer=new Float32Array(analyser.fftSize);running=true;lastAnalysis=0;resetReading('Play G, D, A or E');startBtn.disabled=true;stopBtn.disabled=false;setLive(true,'Listening');status.textContent='Listening live · low-latency violin detection';analyseRAF=requestAnimationFrame(analyse);
    }catch(err){setLive(false,'Ready');status.textContent=`Microphone unavailable: ${err?.message||'permission denied'}`}
  }

  function stop(){
    running=false;if(analyseRAF)cancelAnimationFrame(analyseRAF);analyseRAF=0;if(source){try{source.disconnect()}catch(_){}source=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}analyser=null;buffer=null;startBtn.disabled=false;stopBtn.disabled=true;setLive(false,'Ready');resetReading();status.textContent='Microphone stopped';
  }

  pitchSlider.addEventListener('input',e=>{refPitch=Number(e.target.value);pitchText.textContent=`${refPitch.toFixed(1)} Hz`;updateReferenceLabels();setPresetActive();centsHistory=[];freqHistory=[];lockKey=null;if(activeRef!==null){const b=document.querySelector(`.ref-btn[data-midi="${activeRef}"]`);if(b)playReference(activeRef,b)}});
  document.querySelectorAll('.preset').forEach(b=>b.addEventListener('click',()=>{pitchSlider.value=b.dataset.pitch;pitchSlider.dispatchEvent(new Event('input',{bubbles:true}))}));
  document.querySelectorAll('.ref-btn').forEach(b=>b.addEventListener('click',()=>{const m=Number(b.dataset.midi);if(activeRef===m){stopReference();status.textContent=running?'Listening…':'Ready'}else playReference(m,b)}));
  loopPlay.addEventListener('change',()=>{if(audio)audio.loop=loopPlay.checked});startBtn.addEventListener('click',start);stopBtn.addEventListener('click',stop);
  document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const map={q:55,w:62,e:69,r:76},m=map[e.key.toLowerCase()];if(m){const b=document.querySelector(`.ref-btn[data-midi="${m}"]`);if(b)playReference(m,b)}});
  window.__SOUND_TUNER_DEBUG__={injectFrequency(frequency,clarity=.98,rms=.05){showReading({frequency,clarity,rms})},reset(){resetReading()}};
  window.addEventListener('pagehide',()=>{stop();stopReference();if(needleRAF)cancelAnimationFrame(needleRAF)});
})();
