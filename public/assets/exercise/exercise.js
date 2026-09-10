(() => {
  'use strict';

  const LETTERS = ['C','D','E','F','G','A','B'];
  const SEMITONES = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
  const CLEFS = {
    treble:{label:'Treble', glyph:'𝄞', bottom:30, glyphX:102, glyphY:190, glyphSize:105}, // E4 bottom line
    bass:{label:'Bass', glyph:'𝄢', bottom:18, glyphX:108, glyphY:161, glyphSize:78},     // G2 bottom line
    alto:{label:'Alto', glyph:'𝄡', bottom:24, glyphX:106, glyphY:172, glyphSize:83},    // F3 bottom line, C4 center
    tenor:{label:'Tenor', glyph:'𝄡', bottom:22, glyphX:106, glyphY:151, glyphSize:83}   // D3 bottom line, C4 fourth line
  };
  const RANGES = {
    easy:{label:'Easy', min:0, max:8},
    standard:{label:'Standard', min:-2, max:10},
    extended:{label:'Extended', min:-4, max:12},
    wide:{label:'Wide', min:-6, max:14}
  };
  const KEY_SIGNATURES = {
    C:{label:'C',type:'',count:0,accidentals:{}},
    G:{label:'G',type:'#',count:1,accidentals:{F:'#'}},
    D:{label:'D',type:'#',count:2,accidentals:{F:'#',C:'#'}},
    A:{label:'A',type:'#',count:3,accidentals:{F:'#',C:'#',G:'#'}},
    E:{label:'E',type:'#',count:4,accidentals:{F:'#',C:'#',G:'#',D:'#'}},
    B:{label:'B',type:'#',count:5,accidentals:{F:'#',C:'#',G:'#',D:'#',A:'#'}},
    Fs:{label:'F♯',type:'#',count:6,accidentals:{F:'#',C:'#',G:'#',D:'#',A:'#',E:'#'}},
    Cs:{label:'C♯',type:'#',count:7,accidentals:{F:'#',C:'#',G:'#',D:'#',A:'#',E:'#',B:'#'}},
    F:{label:'F',type:'b',count:1,accidentals:{B:'b'}},
    Bb:{label:'B♭',type:'b',count:2,accidentals:{B:'b',E:'b'}},
    Eb:{label:'E♭',type:'b',count:3,accidentals:{B:'b',E:'b',A:'b'}},
    Ab:{label:'A♭',type:'b',count:4,accidentals:{B:'b',E:'b',A:'b',D:'b'}},
    Db:{label:'D♭',type:'b',count:5,accidentals:{B:'b',E:'b',A:'b',D:'b',G:'b'}},
    Gb:{label:'G♭',type:'b',count:6,accidentals:{B:'b',E:'b',A:'b',D:'b',G:'b',C:'b'}},
    Cb:{label:'C♭',type:'b',count:7,accidentals:{B:'b',E:'b',A:'b',D:'b',G:'b',C:'b',F:'b'}}
  };
  const KEY_SIG_STEPS = {
    treble:{'#':[8,5,9,6,3,7,4],b:[4,7,3,6,2,5,1]},
    bass:{'#':[6,3,7,4,1,5,2],b:[2,5,1,4,0,3,-1]},
    alto:{'#':[7,4,8,5,2,6,3],b:[3,6,2,5,1,4,0]},
    tenor:{'#':[9,6,10,7,4,8,5],b:[5,8,4,7,3,6,2]}
  };

  const $ = id => document.getElementById(id);
  const els = {
    staff:$('staffDrawing'), staffDesc:$('staffDesc'), answerGrid:$('answerGrid'), status:$('questionStatus'),
    tone:$('toneButton'), reveal:$('revealBtn'), reset:$('resetBtn'), next:$('nextBtn'),
    correct:$('correctStat'), attempts:$('attemptStat'), accuracy:$('accuracyStat'), streak:$('streakStat'), time:$('timeStat'),
    clefMeta:$('clefMeta'), rangeMeta:$('rangeMeta'),
    sumClefs:$('sumClefs'), sumRange:$('sumRange'), sumKeys:$('sumKeys'), sumAccidentals:$('sumAccidentals'), sumNotes:$('sumNotes'),
    settingsBackdrop:$('settingsBackdrop'), settingsTop:$('settingsTop'), settingsSide:$('settingsSide'), settingsClose:$('settingsClose'), applySettings:$('applySettings'),
    accidentalMode:$('accidentalMode'), multipleAttempts:$('multipleAttempts'), autoAdvance:$('autoAdvance'), soundOnCorrect:$('soundOnCorrect'), challengeMode:$('challengeMode'),
    challengeBadge:$('challengeBadge'), challengeText:$('challengeText'), challengeProgress:$('challengeProgress'), challengeAction:$('challengeAction'),
    reportBackdrop:$('reportBackdrop'), reportTop:$('reportTop'), reportClose:$('reportClose'), reportReset:$('reportReset'), reportSubtitle:$('reportSubtitle'),
    reportCorrect:$('reportCorrect'), reportQuestions:$('reportQuestions'), reportAccuracy:$('reportAccuracy'), reportTime:$('reportTime'), reportBest:$('reportBest'), reportMode:$('reportMode'), toast:$('toast')
  };

  const defaults = {
    clefs:['treble'], range:'standard', notes:[...LETTERS], keySignatures:['C'], accidentals:'off', multipleAttempts:true,
    autoAdvance:true, soundOnCorrect:true, challenge:'off'
  };

  const state = {
    settings:loadSettings(), question:null, lastQuestionKey:'', resolved:false, wrongThisQuestion:false,
    correct:0, questions:0, streak:0, bestStreak:0, startedAt:Date.now(), challengeEnded:false,
    up:false, down:false, autoTimer:0, ticker:0, audio:null, audioCtx:null, toastTimer:0
  };

  function loadSettings(){
    try {
      const saved = JSON.parse(localStorage.getItem('violin-note-exercise-settings') || 'null');
      return {...defaults, ...(saved || {})};
    } catch { return {...defaults}; }
  }
  function saveSettings(){
    try { localStorage.setItem('violin-note-exercise-settings', JSON.stringify(state.settings)); } catch {}
  }
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function mod(n,m){ return ((n%m)+m)%m; }
  function diatonicToNote(idx){
    const letter=LETTERS[mod(idx,7)], octave=Math.floor(idx/7);
    return {letter,octave};
  }
  function midiFor(letter,octave,acc){
    let midi=(octave+1)*12+SEMITONES[letter];
    if(acc==='#') midi++; else if(acc==='b') midi--;
    return midi;
  }
  function frequency(midi){ return 440*Math.pow(2,(midi-69)/12); }
  function accidentalSymbol(acc){ return acc==='#'?'♯':acc==='b'?'♭':acc==='n'?'♮':''; }
  function answerName(letter,acc){ return letter+accidentalSymbol(acc); }
  function formatTime(ms){
    const sec=Math.max(0,Math.floor(ms/1000));
    return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
  }
  function accuracy(){ return state.questions ? Math.round((state.correct/state.questions)*100) : null; }
  function challengeInfo(){
    const v=state.settings.challenge;
    if(v==='off') return {type:'off',label:'Practice'};
    if(v[0]==='q') return {type:'questions',target:+v.slice(1),label:`${v.slice(1)} questions`};
    return {type:'time',target:+v.slice(1),label:v==='t60'?'60 seconds':v==='t120'?'2 minutes':'5 minutes'};
  }

  function chooseAccidental(keyAccidental=''){
    const mode=state.settings.accidentals;
    if(mode==='off') return {final:keyAccidental,written:''};
    let final='';
    if(mode==='sharp') final=Math.random()<.42?'#':'';
    else if(mode==='flat') final=Math.random()<.42?'b':'';
    else { const r=Math.random(); final=r<.26?'#':r<.52?'b':''; }
    const written=final===keyAccidental?'':(final===''&&keyAccidental?'n':final);
    return {final,written};
  }

  function buildQuestion(){
    clearTimeout(state.autoTimer);
    state.resolved=false; state.wrongThisQuestion=false;
    const clef=rand(state.settings.clefs.length?state.settings.clefs:['treble']);
    const cfg=CLEFS[clef];
    const range=RANGES[state.settings.range] || RANGES.standard;
    const allowed=state.settings.notes.length?state.settings.notes:LETTERS;
    const keySig=rand(state.settings.keySignatures?.length?state.settings.keySignatures:['C']);
    const sig=KEY_SIGNATURES[keySig]||KEY_SIGNATURES.C;
    let q=null;
    for(let i=0;i<120;i++){
      const step=range.min+Math.floor(Math.random()*(range.max-range.min+1));
      const baseIdx=cfg.bottom+step;
      const n=diatonicToNote(baseIdx);
      if(!allowed.includes(n.letter)) continue;
      const keyAcc=sig.accidentals[n.letter]||'';
      const chosen=chooseAccidental(keyAcc);
      const key=`${clef}:${keySig}:${baseIdx}:${chosen.final}:${chosen.written}`;
      if(key===state.lastQuestionKey && i<100) continue;
      q={clef,keySig,step,baseIdx,letter:n.letter,octave:n.octave,accidental:chosen.final,writtenAccidental:chosen.written,midi:midiFor(n.letter,n.octave,chosen.final),key};
      break;
    }
    if(!q){
      const n=diatonicToNote(cfg.bottom+4), keyAcc=sig.accidentals[n.letter]||'';
      q={clef,keySig,step:4,baseIdx:cfg.bottom+4,letter:n.letter,octave:n.octave,accidental:keyAcc,writtenAccidental:'',midi:midiFor(n.letter,n.octave,keyAcc),key:`${clef}:${keySig}:${cfg.bottom+4}:${keyAcc}`};
    }
    state.question=q; state.lastQuestionKey=q.key;
    drawStaff(); renderAnswers(); setStatus('ask','What note is this?','Choose the note name below or use your keyboard.');
    els.clefMeta.textContent=`${CLEFS[q.clef].label} clef`; els.rangeMeta.textContent=`${KEY_SIGNATURES[q.keySig].label} major · ${RANGES[state.settings.range].label} range`;
    checkChallenge();
  }

  function svgEl(tag,attrs={}){
    const e=document.createElementNS('http://www.w3.org/2000/svg',tag);
    Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));
    return e;
  }
  function drawStaff(){
    const q=state.question, cfg=CLEFS[q.clef];
    const left=70,right=735,bottomY=190,lineGap=20,half=10;
    els.staff.innerHTML='';
    // faint paper guide behind staff
    const plate=svgEl('rect',{x:44,y:64,width:706,height:164,rx:18,fill:'#fff',stroke:'#edf1f5'}); els.staff.appendChild(plate);
    for(let i=0;i<5;i++){
      const y=bottomY-i*lineGap;
      els.staff.appendChild(svgEl('line',{x1:left,y1:y,x2:right,y2:y,class:'staff-line'}));
    }
    const clef=svgEl('text',{x:cfg.glyphX,y:cfg.glyphY,class:'clef','font-size':cfg.glyphSize,'text-anchor':'middle'}); clef.textContent=cfg.glyph; els.staff.appendChild(clef);
    const sig=KEY_SIGNATURES[q.keySig]||KEY_SIGNATURES.C;
    if(sig.count&&sig.type){
      const steps=KEY_SIG_STEPS[q.clef][sig.type];
      for(let i=0;i<sig.count;i++){
        const ks=svgEl('text',{x:174+i*22,y:bottomY-steps[i]*half+10,class:'key-symbol','text-anchor':'middle'}); ks.textContent=accidentalSymbol(sig.type); els.staff.appendChild(ks);
      }
    }
    const x=515, y=bottomY-q.step*half;
    // ledger lines: every even staff step outside 0..8
    if(q.step<0){
      for(let s=-2;s>=q.step-(q.step%2!==0?1:0);s-=2){
        const ly=bottomY-s*half; els.staff.appendChild(svgEl('line',{x1:x-31,y1:ly,x2:x+31,y2:ly,class:'ledger'}));
      }
    }
    if(q.step>8){
      for(let s=10;s<=q.step+(q.step%2!==0?1:0);s+=2){
        const ly=bottomY-s*half; els.staff.appendChild(svgEl('line',{x1:x-31,y1:ly,x2:x+31,y2:ly,class:'ledger'}));
      }
    }
    if(q.writtenAccidental){
      const a=svgEl('text',{x:x-42,y:y+12,class:'accidental','text-anchor':'middle'}); a.textContent=accidentalSymbol(q.writtenAccidental); els.staff.appendChild(a);
    }
    const note=svgEl('ellipse',{cx:x,cy:y,rx:15,ry:10,class:'note-ring',transform:`rotate(-13 ${x} ${y})`}); els.staff.appendChild(note);
    const caption=svgEl('text',{x:390,y:252,class:'staff-caption','text-anchor':'middle'}); caption.textContent=`${cfg.label} clef · ${KEY_SIGNATURES[q.keySig].label} major · ${RANGES[state.settings.range].label} range`; els.staff.appendChild(caption);
    els.staffDesc.textContent=`Identify a note on the ${cfg.label.toLowerCase()} clef.`;
  }

  function answerRows(){
    const mode=state.settings.accidentals, keys=(state.settings.keySignatures||['C']).map(k=>KEY_SIGNATURES[k]||KEY_SIGNATURES.C);
    const rows=[];
    const needSharps=mode==='simple'||mode==='sharp'||keys.some(k=>k.type==='#');
    const needFlats=mode==='simple'||mode==='flat'||keys.some(k=>k.type==='b');
    if(needSharps) rows.push({label:'Sharps',acc:'#'});
    rows.push({label:'Naturals',acc:''});
    if(needFlats) rows.push({label:'Flats',acc:'b'});
    return rows;
  }
  function renderAnswers(){
    const selected=new Set(state.settings.notes.length?state.settings.notes:LETTERS);
    els.answerGrid.innerHTML='';
    for(const row of answerRows()){
      const lab=document.createElement('div'); lab.className='answer-row-label'; lab.textContent=row.label; els.answerGrid.appendChild(lab);
      for(const letter of LETTERS){
        const b=document.createElement('button'); b.type='button'; b.className='answer-btn';
        b.textContent=answerName(letter,row.acc); b.dataset.answer=letter+(row.acc||'');
        b.disabled=!selected.has(letter); if(!selected.has(letter)) b.style.visibility='hidden';
        b.addEventListener('click',()=>submitAnswer(letter,row.acc,b)); els.answerGrid.appendChild(b);
      }
    }
  }

  function submitAnswer(letter,acc,button){
    if(state.challengeEnded||state.resolved||!state.question) return;
    const q=state.question, isCorrect=letter===q.letter&&acc===q.accidental;
    if(isCorrect){
      state.resolved=true; state.questions++;
      if(!state.wrongThisQuestion){ state.correct++; state.streak++; state.bestStreak=Math.max(state.bestStreak,state.streak); }
      else state.streak=0;
      markCorrectAnswer(); button.classList.add('correct');
      setStatus('good',state.wrongThisQuestion?'Correct — nice recovery.':'Correct!',`${answerName(q.letter,q.accidental)}${q.octave} · ${frequency(q.midi).toFixed(1)} Hz`);
      updateStats(); checkChallenge();
      if(state.settings.soundOnCorrect) playQuestionTone();
      if(state.settings.autoAdvance&&!state.challengeEnded) state.autoTimer=setTimeout(buildQuestion,820);
      return;
    }
    state.wrongThisQuestion=true; state.streak=0; button.classList.add('wrong'); updateStats();
    if(state.settings.multipleAttempts){
      button.disabled=true; setStatus('bad','Not quite. Try again.','The question stays open until you find the note or reveal it.');
    } else {
      state.resolved=true; state.questions++; markCorrectAnswer();
      setStatus('bad','Incorrect.',`The answer is ${answerName(q.letter,q.accidental)}${q.octave}.`); updateStats(); checkChallenge();
    }
  }
  function markCorrectAnswer(){
    const target=state.question.letter+(state.question.accidental||'');
    [...els.answerGrid.querySelectorAll('.answer-btn')].forEach(b=>{
      b.disabled=true; if(b.dataset.answer===target) b.classList.add('answer');
    });
  }
  function reveal(){
    if(state.challengeEnded||state.resolved||!state.question) return;
    state.resolved=true; state.questions++; state.streak=0; state.wrongThisQuestion=true; markCorrectAnswer();
    const q=state.question; setStatus('reveal',`Answer: ${answerName(q.letter,q.accidental)}${q.octave}`,`${frequency(q.midi).toFixed(1)} Hz`); updateStats(); checkChallenge();
  }
  function skip(){
    if(state.challengeEnded) return;
    if(!state.resolved&&state.question){ state.questions++; state.streak=0; }
    updateStats(); checkChallenge(); if(!state.challengeEnded) buildQuestion();
  }
  function setStatus(type,title,sub){ els.status.className='question-status'+(type==='ask'?'':` ${type}`); els.status.innerHTML=`<strong>${esc(title)}</strong><small>${esc(sub)}</small>`; }

  function updateStats(){
    els.correct.textContent=state.correct; els.attempts.textContent=state.questions; const a=accuracy(); els.accuracy.textContent=a===null?'—':`${a}%`; els.streak.textContent=state.streak;
    updateChallengeUI();
  }
  function updateTimer(){
    const now=Date.now(), elapsed=now-state.startedAt; const ch=challengeInfo();
    if(ch.type==='time'&&!state.challengeEnded){
      const remain=Math.max(0,ch.target*1000-elapsed); els.time.textContent=formatTime(remain); if(remain<=0) endChallenge('Time is up.');
    } else els.time.textContent=formatTime(elapsed);
    updateChallengeUI();
  }
  function updateChallengeUI(){
    const ch=challengeInfo();
    if(ch.type==='off'){
      els.challengeBadge.textContent='Off'; els.challengeText.textContent='Practice without a limit, or enable a timed/question challenge in Settings.'; els.challengeProgress.style.width='0%'; els.challengeAction.textContent='Configure challenge'; return;
    }
    els.challengeBadge.textContent=state.challengeEnded?'Finished':'Live';
    if(ch.type==='questions'){
      const pct=Math.min(100,(state.questions/ch.target)*100); els.challengeProgress.style.width=`${pct}%`; els.challengeText.innerHTML=`<b>${state.questions}/${ch.target}</b> questions completed · ${accuracy()??0}% accuracy.`;
    } else {
      const elapsed=(Date.now()-state.startedAt)/1000, pct=Math.min(100,(elapsed/ch.target)*100); els.challengeProgress.style.width=`${pct}%`; els.challengeText.innerHTML=`<b>${formatTime(Math.max(0,ch.target*1000-(Date.now()-state.startedAt)))}</b> remaining · ${state.questions} questions completed.`;
    }
    els.challengeAction.textContent=state.challengeEnded?'View result':'Challenge running';
  }
  function checkChallenge(){
    const ch=challengeInfo(); if(ch.type==='questions'&&!state.challengeEnded&&state.questions>=ch.target) endChallenge('Question goal complete.');
  }
  function endChallenge(message){
    if(state.challengeEnded) return; state.challengeEnded=true; clearTimeout(state.autoTimer); markCorrectAnswer(); updateChallengeUI(); toast(message); openReport(message);
  }
  function resetSession(showToast=true){
    clearTimeout(state.autoTimer); state.correct=0; state.questions=0; state.streak=0; state.bestStreak=0; state.startedAt=Date.now(); state.challengeEnded=false; updateStats(); buildQuestion(); if(showToast) toast('Session reset');
  }

  async function playQuestionTone(){
    if(!state.question) return;
    stopAudio(); const midi=state.question.midi;
    const manifest=window.EXERCISE_TONES||{}; const src=manifest[String(midi)]||manifest[midi];
    if(src){
      try{
        const a=new Audio(src); a.volume=.72; state.audio=a; els.tone.classList.add('playing'); els.tone.textContent='■ Stop tone';
        a.onended=()=>toneIdle(); a.onerror=()=>{toneIdle(); synthTone(midi)}; await a.play(); return;
      }catch{ toneIdle(); }
    }
    synthTone(midi);
  }
  function synthTone(midi){
    try{
      const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
      const ctx=state.audioCtx||(state.audioCtx=new AC()); if(ctx.state==='suspended') ctx.resume();
      const now=ctx.currentTime, master=ctx.createGain(); master.gain.setValueAtTime(.0001,now); master.gain.exponentialRampToValueAtTime(.22,now+.018); master.gain.exponentialRampToValueAtTime(.0001,now+1.55); master.connect(ctx.destination);
      const f=frequency(midi); const oscs=[];
      [[1,1],[2,.26],[3,.10],[4,.045]].forEach(([mul,amp])=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type=mul===1?'triangle':'sine'; o.frequency.value=f*mul; g.gain.value=amp; o.connect(g).connect(master); o.start(now); o.stop(now+1.6); oscs.push(o); });
      state.audio={stop:()=>{try{master.gain.cancelScheduledValues(ctx.currentTime);master.gain.setTargetAtTime(.0001,ctx.currentTime,.02);oscs.forEach(o=>o.stop(ctx.currentTime+.08));}catch{}}};
      els.tone.classList.add('playing'); els.tone.textContent='■ Stop tone'; setTimeout(()=>{if(state.audio&&state.audio.stop)toneIdle()},1650);
    }catch{}
  }
  function stopAudio(){
    if(state.audio){ try{state.audio.pause?.(); state.audio.currentTime=0;}catch{} try{state.audio.stop?.();}catch{} state.audio=null; } toneIdle();
  }
  function toneIdle(){ els.tone.classList.remove('playing'); els.tone.textContent='♪ Hear note'; state.audio=null; }

  function syncSettingsForm(){
    document.querySelectorAll('#clefOptions input').forEach(i=>i.checked=state.settings.clefs.includes(i.value));
    const r=document.querySelector(`input[name="range"][value="${state.settings.range}"]`); if(r) r.checked=true;
    document.querySelectorAll('#noteOptions input').forEach(i=>i.checked=state.settings.notes.includes(i.value));
    document.querySelectorAll('#keyOptions input').forEach(i=>i.checked=(state.settings.keySignatures||['C']).includes(i.value));
    els.accidentalMode.value=state.settings.accidentals; els.multipleAttempts.checked=state.settings.multipleAttempts; els.autoAdvance.checked=state.settings.autoAdvance; els.soundOnCorrect.checked=state.settings.soundOnCorrect; els.challengeMode.value=state.settings.challenge;
  }
  function readSettingsForm(){
    let clefs=[...document.querySelectorAll('#clefOptions input:checked')].map(i=>i.value); if(!clefs.length){clefs=['treble']; document.querySelector('#clefOptions input[value="treble"]').checked=true; toast('At least one clef is required');}
    let notes=[...document.querySelectorAll('#noteOptions input:checked')].map(i=>i.value); if(!notes.length){notes=[...LETTERS]; document.querySelectorAll('#noteOptions input').forEach(i=>i.checked=true); toast('At least one note is required');}
    let keySignatures=[...document.querySelectorAll('#keyOptions input:checked')].map(i=>i.value); if(!keySignatures.length){keySignatures=['C']; document.querySelector('#keyOptions input[value="C"]').checked=true; toast('At least one key signature is required');}
    state.settings={clefs,range:document.querySelector('input[name="range"]:checked')?.value||'standard',notes,keySignatures,accidentals:els.accidentalMode.value,multipleAttempts:els.multipleAttempts.checked,autoAdvance:els.autoAdvance.checked,soundOnCorrect:els.soundOnCorrect.checked,challenge:els.challengeMode.value}; saveSettings();
  }
  function updateSummary(){
    els.sumClefs.textContent=state.settings.clefs.map(c=>CLEFS[c].label).join(', '); els.sumRange.textContent=RANGES[state.settings.range].label;
    const keyLabels=(state.settings.keySignatures||['C']).map(k=>(KEY_SIGNATURES[k]||KEY_SIGNATURES.C).label); els.sumKeys.textContent=keyLabels.length>5?`${keyLabels.slice(0,4).join(', ')} +${keyLabels.length-4}`:keyLabels.join(', ');
    els.sumAccidentals.textContent=state.settings.accidentals==='off'?'Off':state.settings.accidentals==='simple'?'Sharps + flats':state.settings.accidentals==='sharp'?'Sharps only':'Flats only'; els.sumNotes.textContent=state.settings.notes.join(' ');
  }
  function openSettings(){ syncSettingsForm(); els.settingsBackdrop.classList.add('open'); els.settingsBackdrop.setAttribute('aria-hidden','false'); }
  function closeSettings(){ els.settingsBackdrop.classList.remove('open'); els.settingsBackdrop.setAttribute('aria-hidden','true'); }
  function applySettings(){ readSettingsForm(); updateSummary(); closeSettings(); resetSession(false); toast('Exercise updated'); }

  function openReport(extra='Your current session summary.'){
    const a=accuracy(); els.reportSubtitle.textContent=extra; els.reportCorrect.textContent=state.correct; els.reportQuestions.textContent=state.questions; els.reportAccuracy.textContent=a===null?'—':`${a}%`; els.reportTime.textContent=formatTime(Date.now()-state.startedAt); els.reportBest.textContent=state.bestStreak; els.reportMode.textContent=challengeInfo().label; els.reportBackdrop.classList.add('open'); els.reportBackdrop.setAttribute('aria-hidden','false');
  }
  function closeReport(){ els.reportBackdrop.classList.remove('open'); els.reportBackdrop.setAttribute('aria-hidden','true'); }
  function toast(msg){ clearTimeout(state.toastTimer); els.toast.textContent=msg; els.toast.classList.add('show'); state.toastTimer=setTimeout(()=>els.toast.classList.remove('show'),1800); }

  function keyboardAnswer(e){
    const tag=document.activeElement?.tagName; if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
    if(e.key==='ArrowUp'){state.up=true;return} if(e.key==='ArrowDown'){state.down=true;return}
    if(e.shiftKey&&e.key.toLowerCase()==='r'){e.preventDefault();reveal();return}
    if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();skip();return}
    if(e.shiftKey&&e.key.toLowerCase()==='p'){e.preventDefault();openReport();return}
    const letter=e.key.toUpperCase(); if(!LETTERS.includes(letter)) return;
    e.preventDefault(); const acc=state.up?'#':state.down?'b':'';
    const b=[...els.answerGrid.querySelectorAll('.answer-btn')].find(x=>x.dataset.answer===letter+acc&&!x.disabled);
    if(b) b.click(); else toast(`${answerName(letter,acc)} is not enabled in this exercise`);
  }

  els.tone.addEventListener('click',()=>state.audio?stopAudio():playQuestionTone()); els.reveal.addEventListener('click',reveal); els.next.addEventListener('click',skip); els.reset.addEventListener('click',()=>resetSession());
  [els.settingsTop,els.settingsSide,els.challengeAction].forEach(b=>b.addEventListener('click',()=>state.challengeEnded?openReport():openSettings())); els.settingsClose.addEventListener('click',closeSettings); els.settingsBackdrop.addEventListener('click',e=>{if(e.target===els.settingsBackdrop)closeSettings()}); els.applySettings.addEventListener('click',applySettings);
  els.reportTop.addEventListener('click',()=>openReport()); els.reportClose.addEventListener('click',closeReport); els.reportBackdrop.addEventListener('click',e=>{if(e.target===els.reportBackdrop)closeReport()}); els.reportReset.addEventListener('click',()=>{closeReport();resetSession()});
  document.addEventListener('keydown',keyboardAnswer); document.addEventListener('keyup',e=>{if(e.key==='ArrowUp')state.up=false;if(e.key==='ArrowDown')state.down=false;if(e.key==='Escape'){closeSettings();closeReport();}}); window.addEventListener('blur',()=>{state.up=false;state.down=false});

  syncSettingsForm(); updateSummary(); updateStats(); buildQuestion(); state.ticker=setInterval(updateTimer,250); updateTimer();
})();
