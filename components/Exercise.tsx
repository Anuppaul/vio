'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

const LETTERS=['C','D','E','F','G','A','B'];
const SEMITONES:Record<string,number>={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const CLEFS={
 treble:{label:'Treble',glyph:'𝄞',bottom:30,glyphY:190,glyphSize:105},
 bass:{label:'Bass',glyph:'𝄢',bottom:18,glyphY:161,glyphSize:78},
 alto:{label:'Alto',glyph:'𝄡',bottom:24,glyphY:172,glyphSize:83},
 tenor:{label:'Tenor',glyph:'𝄡',bottom:22,glyphY:151,glyphSize:83}
} as const;
const LEGACY_RANGES={easy:{min:0,max:8},standard:{min:-2,max:10},extended:{min:-4,max:12},wide:{min:-6,max:14}} as const;
const KEYS:Record<string,{label:string;type:string;count:number;acc:Record<string,string>}>= {
 C:{label:'C',type:'',count:0,acc:{}},G:{label:'G',type:'#',count:1,acc:{F:'#'}},D:{label:'D',type:'#',count:2,acc:{F:'#',C:'#'}},A:{label:'A',type:'#',count:3,acc:{F:'#',C:'#',G:'#'}},E:{label:'E',type:'#',count:4,acc:{F:'#',C:'#',G:'#',D:'#'}},B:{label:'B',type:'#',count:5,acc:{F:'#',C:'#',G:'#',D:'#',A:'#'}},Fs:{label:'F♯',type:'#',count:6,acc:{F:'#',C:'#',G:'#',D:'#',A:'#',E:'#'}},Cs:{label:'C♯',type:'#',count:7,acc:{F:'#',C:'#',G:'#',D:'#',A:'#',E:'#',B:'#'}},F:{label:'F',type:'b',count:1,acc:{B:'b'}},Bb:{label:'B♭',type:'b',count:2,acc:{B:'b',E:'b'}},Eb:{label:'E♭',type:'b',count:3,acc:{B:'b',E:'b',A:'b'}},Ab:{label:'A♭',type:'b',count:4,acc:{B:'b',E:'b',A:'b',D:'b'}},Db:{label:'D♭',type:'b',count:5,acc:{B:'b',E:'b',A:'b',D:'b',G:'b'}},Gb:{label:'G♭',type:'b',count:6,acc:{B:'b',E:'b',A:'b',D:'b',G:'b',C:'b'}},Cb:{label:'C♭',type:'b',count:7,acc:{B:'b',E:'b',A:'b',D:'b',G:'b',C:'b',F:'b'}}
};
const KEY_ORDER=['C','G','D','A','E','B','Fs','Cs','F','Bb','Eb','Ab','Db','Gb','Cb'];
const KEY_STEPS:Record<string,Record<string,number[]>>={treble:{'#':[8,5,9,6,3,7,4],b:[4,7,3,6,2,5,1]},bass:{'#':[6,3,7,4,1,5,2],b:[2,5,1,4,0,3,-1]},alto:{'#':[7,4,8,5,2,6,3],b:[3,6,2,5,1,4,0]},tenor:{'#':[9,6,10,7,4,8,5],b:[5,8,4,7,3,6,2]}};
const KEY_TONICS:Record<string,{letter:string;pc:number}>={C:{letter:'C',pc:0},G:{letter:'G',pc:7},D:{letter:'D',pc:2},A:{letter:'A',pc:9},E:{letter:'E',pc:4},B:{letter:'B',pc:11},Fs:{letter:'F',pc:6},Cs:{letter:'C',pc:1},F:{letter:'F',pc:5},Bb:{letter:'B',pc:10},Eb:{letter:'E',pc:3},Ab:{letter:'A',pc:8},Db:{letter:'D',pc:1},Gb:{letter:'G',pc:6},Cb:{letter:'C',pc:11}};
const MAJOR_STEPS=[0,2,4,5,7,9,11];

const AUDIO_MIN_MIDI=36;
const AUDIO_MAX_MIDI=96;
const CHROMATIC_NAMES=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const NOTE_TOKENS=[...LETTERS.map(l=>`${l}#`),...LETTERS,...LETTERS.map(l=>`${l}b`)];
const SOLFEGE=['Do','Re','Mi','Fa','Sol','La','Ti'];
const SOLFEGE_SI=['Do','Re','Mi','Fa','Sol','La','Si'];
const FIXED_CHROMATIC:Record<string,string>={C:'Do','C#':'Di',Cb:'Do♭',D:'Re','D#':'Ri',Db:'Ra',E:'Mi','E#':'Mi♯',Eb:'Me',F:'Fa','F#':'Fi',Fb:'Fa♭',G:'Sol','G#':'Si',Gb:'Se',A:'La','A#':'Li',Ab:'Le',B:'Ti','B#':'Ti♯',Bb:'Te'};

const DEFAULT_RANGES={
 treble:{min:53,max:88},
 bass:{min:36,max:67},
 alto:{min:48,max:84},
 tenor:{min:48,max:84}
} as const;

type Clef=keyof typeof CLEFS;
type LegacyRange=keyof typeof LEGACY_RANGES;
type PositionMode='all'|'lines'|'spaces';
type NoteNameMode='letters'|'german'|'fixed-do-ti'|'fixed-do-si'|'fixed-chromatic'|'movable-major-do'|'movable-minor-la'|'scale-degrees';
type NextQuestionMode='immediately'|'after-audio';
type RangeSetting={min:number;max:number};
type Settings={
 clefs:Clef[];
 ranges:Record<Clef,RangeSetting>;
 positions:PositionMode;
 keys:string[];
 noteNames:NoteNameMode;
 helpers:boolean;
 accidentals:boolean;
 noteFilter:boolean;
 noteFilterValues:string[];
 nextQuestion:NextQuestionMode;
 challengeMode:boolean;
 timeLimitMinutes:number;
 questionLimit:number;
 multiple:boolean;
};
type Question={clef:Clef;key:string;step:number;letter:string;octave:number;acc:string;written:string;midi:number;id:string};
type RangeHandle='low'|'high';

const DEFAULTS:Settings={
 clefs:['treble'],
 ranges:{treble:{...DEFAULT_RANGES.treble},bass:{...DEFAULT_RANGES.bass},alto:{...DEFAULT_RANGES.alto},tenor:{...DEFAULT_RANGES.tenor}},
 positions:'all',
 keys:['C'],
 noteNames:'letters',
 helpers:false,
 accidentals:false,
 noteFilter:false,
 noteFilterValues:[...NOTE_TOKENS],
 nextQuestion:'after-audio',
 challengeMode:false,
 timeLimitMinutes:0,
 questionLimit:0,
 multiple:true
};

const mod=(n:number,m:number)=>((n%m)+m)%m;
const accidental=(a:string)=>a==='#'?'♯':a==='b'?'♭':a==='n'?'♮':'';
const midiFor=(l:string,o:number,a:string)=>(o+1)*12+SEMITONES[l]+(a==='#'?1:a==='b'?-1:0);
const noteAt=(idx:number)=>({letter:LETTERS[mod(idx,7)],octave:Math.floor(idx/7)});
const midiName=(midi:number)=>`${CHROMATIC_NAMES[mod(Math.round(midi),12)]}${Math.floor(Math.round(midi)/12)-1}`;
const fmt=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`};
const rand=<T,>(a:T[])=>a[Math.floor(Math.random()*a.length)];
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const RANGE_NOTES=[...Array.from({length:5},(_,i)=>i+2).flatMap(o=>LETTERS.map((letter,li)=>({letter,octave:o,midi:midiFor(letter,o,''),index:o*7+li}))),{letter:'C',octave:7,midi:96,index:49}];
const nearestNaturalMidi=(midi:number)=>RANGE_NOTES.reduce((best,n)=>Math.abs(n.midi-midi)<Math.abs(best-midi)?n.midi:best,RANGE_NOTES[0].midi);
const rangeNote=(midi:number)=>RANGE_NOTES.reduce((best,n)=>Math.abs(n.midi-midi)<Math.abs(best.midi-midi)?n:best,RANGE_NOTES[0]);
function audioContextCtor(){return window.AudioContext||(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext}

function tokenParts(token:string){const last=token.slice(-1);return{letter:token[0]||'C',acc:last==='#'||last==='b'?last:''}}
function signatureLabel(key:string){const k=KEYS[key]||KEYS.C;if(!k.count)return'None';return`${k.count}${k.type==='b'?'♭':'♯'} · ${k.label}`}
function tokenPitchClass(token:string){const{letter,acc}=tokenParts(token);return mod(SEMITONES[letter]+(acc==='#'?1:acc==='b'?-1:0),12)}
function degreeInfo(token:string,key:string){
 const tonic=KEY_TONICS[key]||KEY_TONICS.C,{letter}=tokenParts(token),degree=mod(LETTERS.indexOf(letter)-LETTERS.indexOf(tonic.letter),7),expected=mod(tonic.pc+MAJOR_STEPS[degree],12),actual=tokenPitchClass(token);
 let delta=actual-expected;if(delta>6)delta-=12;if(delta<-6)delta+=12;delta=clamp(delta,-2,2);
 return{degree,delta};
}
function alteredPrefix(delta:number){return delta>0?'♯'.repeat(delta):delta<0?'♭'.repeat(-delta):''}
function germanName(token:string){const{letter,acc}=tokenParts(token);if(letter==='B'){if(acc==='b')return'B';if(acc==='#')return'His';return'H'}const flat:Record<string,string>={C:'Ces',D:'Des',E:'Es',F:'Fes',G:'Ges',A:'As'};if(acc==='#')return`${letter}is`;if(acc==='b')return flat[letter]||`${letter}es`;return letter}
function answerLabel(token:string,mode:NoteNameMode,key:string){
 const{letter,acc}=tokenParts(token),idx=LETTERS.indexOf(letter),mark=accidental(acc);
 if(mode==='letters')return`${letter}${mark}`;
 if(mode==='german')return germanName(token);
 if(mode==='fixed-do-ti')return`${SOLFEGE[idx]}${mark}`;
 if(mode==='fixed-do-si')return`${SOLFEGE_SI[idx]}${mark}`;
 if(mode==='fixed-chromatic')return FIXED_CHROMATIC[token]||`${SOLFEGE[idx]}${mark}`;
 const info=degreeInfo(token,key),prefix=alteredPrefix(info.delta);
 if(mode==='scale-degrees')return`${prefix}${info.degree+1}`;
 if(mode==='movable-minor-la'||mode==='movable-major-do')return`${prefix}${SOLFEGE[info.degree]}`;
 return`${letter}${mark}`;
}
function normalizeRange(range:Partial<RangeSetting>|undefined,fallback:RangeSetting){
 let min=Number(range?.min),max=Number(range?.max);if(!Number.isFinite(min))min=fallback.min;if(!Number.isFinite(max))max=fallback.max;
 min=nearestNaturalMidi(clamp(min,AUDIO_MIN_MIDI,AUDIO_MAX_MIDI));max=nearestNaturalMidi(clamp(max,AUDIO_MIN_MIDI,AUDIO_MAX_MIDI));if(min>max)[min,max]=[max,min];return{min,max};
}
function migrateSettings(value:unknown):Settings{
 const raw=(value&&typeof value==='object'?value:{}) as Partial<Settings>&{range?:LegacyRange;rangeMin?:number;rangeMax?:number;notes?:string[];accidentals?:unknown;auto?:boolean;sound?:boolean;challenge?:string};
 const clefs=(Array.isArray(raw.clefs)?raw.clefs.filter((c):c is Clef=>typeof c==='string'&&c in CLEFS):[]);if(!clefs.length)clefs.push('treble');
 const ranges:Record<Clef,RangeSetting>={treble:{...DEFAULT_RANGES.treble},bass:{...DEFAULT_RANGES.bass},alto:{...DEFAULT_RANGES.alto},tenor:{...DEFAULT_RANGES.tenor}};
 if(raw.ranges&&typeof raw.ranges==='object'){for(const c of Object.keys(CLEFS) as Clef[])ranges[c]=normalizeRange(raw.ranges[c],ranges[c])}
 else if(Number.isFinite(raw.rangeMin)&&Number.isFinite(raw.rangeMax)){ranges[clefs[0]]=normalizeRange({min:raw.rangeMin,max:raw.rangeMax},ranges[clefs[0]])}
 else if(raw.range&&LEGACY_RANGES[raw.range]){const c=clefs[0],legacy=LEGACY_RANGES[raw.range],cfg=CLEFS[c],lo=noteAt(cfg.bottom+legacy.min),hi=noteAt(cfg.bottom+legacy.max);ranges[c]=normalizeRange({min:midiFor(lo.letter,lo.octave,''),max:midiFor(hi.letter,hi.octave,'')},ranges[c])}
 let noteFilter=Boolean(raw.noteFilter),noteFilterValues=Array.isArray(raw.noteFilterValues)?raw.noteFilterValues.filter(v=>NOTE_TOKENS.includes(v)):[];
 if(!noteFilterValues.length&&Array.isArray(raw.notes)&&raw.notes.length&&raw.notes.length<LETTERS.length){noteFilter=true;noteFilterValues=NOTE_TOKENS.filter(t=>raw.notes?.includes(t[0]))}
 if(!noteFilterValues.length)noteFilterValues=[...NOTE_TOKENS];
 let challengeMode=Boolean(raw.challengeMode),timeLimitMinutes=Math.max(0,Number(raw.timeLimitMinutes)||0),questionLimit=Math.max(0,Math.round(Number(raw.questionLimit)||0));
 if(typeof raw.challenge==='string'&&raw.challenge!=='off'){challengeMode=true;if(raw.challenge.startsWith('q'))questionLimit=Math.max(0,+raw.challenge.slice(1)||0);if(raw.challenge.startsWith('t'))timeLimitMinutes=Math.max(0,(+raw.challenge.slice(1)||0)/60)}
 const oldAcc=raw.accidentals as unknown,accidentals=typeof oldAcc==='boolean'?oldAcc:typeof oldAcc==='string'?oldAcc!=='off':DEFAULTS.accidentals;
 const keys=(Array.isArray(raw.keys)?raw.keys.filter(k=>typeof k==='string'&&k in KEYS):[]);if(!keys.length)keys.push('C');
 return{
  ...DEFAULTS,...raw,clefs:[...new Set(clefs)],ranges,
  positions:raw.positions==='lines'||raw.positions==='spaces'?raw.positions:'all',
  keys:[...new Set(keys)],noteNames:(raw.noteNames||'letters') as NoteNameMode,helpers:Boolean(raw.helpers),accidentals,noteFilter,noteFilterValues,
  nextQuestion:raw.nextQuestion==='immediately'?'immediately':'after-audio',challengeMode,timeLimitMinutes,questionLimit,multiple:raw.multiple!==false
 };
}

export default function Exercise(){
 const [settings,setSettings]=useState<Settings>(DEFAULTS),[draft,setDraft]=useState<Settings>(DEFAULTS),[question,setQuestion]=useState<Question|null>(null),[wrong,setWrong]=useState(false),[wrongAnswers,setWrongAnswers]=useState<string[]>([]),[resolved,setResolved]=useState(false);
 const [correct,setCorrect]=useState(0),[questions,setQuestions]=useState(0),[streak,setStreak]=useState(0),[best,setBest]=useState(0),[started,setStarted]=useState(Date.now()),[now,setNow]=useState(Date.now()),[ended,setEnded]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[reportOpen,setReportOpen]=useState(false),[status,setStatus]=useState('What note is this?');
 const lastId=useRef(''),autoTimer=useRef<ReturnType<typeof setTimeout>|null>(null),audioRef=useRef<HTMLAudioElement|null>(null),ctxRef=useRef<AudioContext|null>(null),sharpHeld=useRef(false),flatHeld=useRef(false);
 useEffect(()=>{try{const saved=localStorage.getItem('vio-exercise-settings');if(saved){const s=migrateSettings(JSON.parse(saved));setSettings(s);setDraft(s)}}catch{}},[]);
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(id)},[]);
 const elapsed=now-started,timeLimitMs=settings.challengeMode&&settings.timeLimitMinutes>0?settings.timeLimitMinutes*60000:0,remaining=timeLimitMs?Math.max(0,timeLimitMs-elapsed):0,accuracy=questions?Math.round(correct/questions*100):null;
 const challengeLabel=useMemo(()=>{if(!settings.challengeMode)return'Practice';const bits:string[]=[];if(settings.timeLimitMinutes>0)bits.push(`${settings.timeLimitMinutes} min`);if(settings.questionLimit>0)bits.push(`${settings.questionLimit} questions`);return bits.length?bits.join(' · '):'Challenge'},[settings.challengeMode,settings.timeLimitMinutes,settings.questionLimit]);
 useEffect(()=>{if(ended||!settings.challengeMode)return;const timeDone=timeLimitMs>0&&remaining<=0,questionDone=settings.questionLimit>0&&questions>=settings.questionLimit;if(timeDone||questionDone){setEnded(true);setReportOpen(true);if(autoTimer.current)clearTimeout(autoTimer.current)}},[remaining,timeLimitMs,questions,settings.challengeMode,settings.questionLimit,ended]);

 const chooseAcc=useCallback((keyAcc:string)=>{if(!settings.accidentals)return{final:keyAcc,written:''};const final=rand(['','#','b']);return{final,written:final===keyAcc?'':(!final&&keyAcc?'n':final)}},[settings.accidentals]);
 const newQuestion=useCallback(()=>{
  if(autoTimer.current)clearTimeout(autoTimer.current);setResolved(false);setWrong(false);setWrongAnswers([]);setStatus('What note is this?');
  const clef=rand<Clef>(settings.clefs.length?settings.clefs:['treble']),cfg=CLEFS[clef],range=settings.ranges[clef]||DEFAULTS.ranges[clef],key=rand<string>(settings.keys.length?settings.keys:['C']),sig=KEYS[key];
  const minStep=14-cfg.bottom,maxStep=49-cfg.bottom;let q:Question|null=null;
  for(let i=0;i<420;i++){
   const step=minStep+Math.floor(Math.random()*(maxStep-minStep+1));if(settings.positions==='lines'&&mod(step,2)!==0)continue;if(settings.positions==='spaces'&&mod(step,2)===0)continue;
   const n=noteAt(cfg.bottom+step),a=chooseAcc(sig.acc[n.letter]||''),token=n.letter+a.final;if(settings.noteFilter&&!settings.noteFilterValues.includes(token))continue;
   const midi=midiFor(n.letter,n.octave,a.final);if(midi<range.min||midi>range.max||midi<AUDIO_MIN_MIDI||midi>AUDIO_MAX_MIDI)continue;
   const id=`${clef}:${key}:${step}:${a.final}:${a.written}`;if(id===lastId.current&&i<360)continue;q={clef,key,step,letter:n.letter,octave:n.octave,acc:a.final,written:a.written,midi,id};break;
  }
  if(q){lastId.current=q.id;setQuestion(q)}else{setQuestion(null);setStatus('No notes match these settings. Adjust ranges, key signatures, accidentals, or Note Filter.')}
 },[settings,chooseAcc]);
 useEffect(()=>{newQuestion()},[newQuestion]);

 function resetSession(){if(autoTimer.current)clearTimeout(autoTimer.current);setCorrect(0);setQuestions(0);setStreak(0);setBest(0);setStarted(Date.now());setNow(Date.now());setEnded(false);newQuestion()}
 async function playTone(){if(!question)return;if(audioRef.current){audioRef.current.pause();audioRef.current=null}const audio=new Audio(`/assets/exercise/midi-${question.midi}.wav`);audio.volume=.72;audioRef.current=audio;try{await audio.play()}catch{const AC=audioContextCtor();if(!AC)return;const ctx=ctxRef.current||(ctxRef.current=new AC());if(ctx.state==='suspended')await ctx.resume();const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='triangle';osc.frequency.value=440*Math.pow(2,(question.midi-69)/12);gain.gain.setValueAtTime(.15,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+1.2);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+1.25)}}
 function willEndAfter(nextQuestions:number){return settings.challengeMode&&settings.questionLimit>0&&nextQuestions>=settings.questionLimit}
 function scheduleNext(nextQuestions:number){if(willEndAfter(nextQuestions))return;const delay=settings.nextQuestion==='after-audio'?1150:120;autoTimer.current=setTimeout(newQuestion,delay)}
 function questionToken(q:Question){return q.letter+q.acc}
 function correctDisplay(q:Question){return answerLabel(questionToken(q),settings.noteNames,q.key)}
 function finishCorrect(){if(!question||resolved||ended)return;setResolved(true);const nextQuestions=questions+1;setQuestions(nextQuestions);if(!wrong){setCorrect(v=>v+1);setStreak(v=>{const n=v+1;setBest(b=>Math.max(b,n));return n})}else setStreak(0);setStatus(`Correct · ${correctDisplay(question)}`);void playTone();scheduleNext(nextQuestions)}
 function answerToken(token:string){if(!question||resolved||ended)return;if(token===questionToken(question)){finishCorrect();return}setWrong(true);setStreak(0);setWrongAnswers(v=>v.includes(token)?v:[...v,token]);if(settings.multiple){setStatus('Try again');return}const nextQuestions=questions+1;setResolved(true);setQuestions(nextQuestions);setStatus(`Answer: ${correctDisplay(question)}`);void playTone();scheduleNext(nextQuestions)}
 function reveal(){if(!question||resolved||ended)return;setResolved(true);setWrong(true);setStreak(0);setQuestions(v=>v+1);setStatus(`Answer: ${correctDisplay(question)}`)}
 function skip(){if(!question||ended)return;if(!resolved)setQuestions(v=>v+1);setStreak(0);newQuestion()}
 function apply(){
  const ranges={...draft.ranges} as Record<Clef,RangeSetting>;for(const c of Object.keys(CLEFS) as Clef[])ranges[c]=normalizeRange(ranges[c],DEFAULTS.ranges[c]);
  const s:Settings={...draft,clefs:draft.clefs.length?draft.clefs:['treble'],ranges,keys:draft.keys.length?draft.keys:['C'],noteFilterValues:draft.noteFilterValues.length?draft.noteFilterValues:[...NOTE_TOKENS],timeLimitMinutes:Math.max(0,Number(draft.timeLimitMinutes)||0),questionLimit:Math.max(0,Math.round(Number(draft.questionLimit)||0))};
  setSettings(s);try{localStorage.setItem('vio-exercise-settings',JSON.stringify(s))}catch{}setSettingsOpen(false);setCorrect(0);setQuestions(0);setStreak(0);setBest(0);setStarted(Date.now());setNow(Date.now());setEnded(false)
 }
 function toggleClef(c:Clef){setDraft(d=>{const on=d.clefs.includes(c);if(on&&d.clefs.length===1)return d;return{...d,clefs:on?d.clefs.filter(x=>x!==c):[...d.clefs,c]}})}
 function toggleKey(k:string){setDraft(d=>{const on=d.keys.includes(k);if(on&&d.keys.length===1)return d;return{...d,keys:on?d.keys.filter(x=>x!==k):[...d.keys,k]}})}
 function toggleFilter(token:string){setDraft(d=>({...d,noteFilterValues:d.noteFilterValues.includes(token)?d.noteFilterValues.filter(x=>x!==token):[...d.noteFilterValues,token]}))}
 function setDraftRange(clef:Clef,min:number,max:number){setDraft(d=>({...d,ranges:{...d.ranges,[clef]:{min,max}}}))}

 const visibleAnswerTokens=useMemo(()=>{
  if(settings.noteFilter)return NOTE_TOKENS.filter(t=>settings.noteFilterValues.includes(t));
  if(settings.accidentals)return[...NOTE_TOKENS];
  const allowed=new Set<string>(LETTERS);for(const k of settings.keys){for(const [l,a] of Object.entries(KEYS[k]?.acc||{}))allowed.add(l+a)}return NOTE_TOKENS.filter(t=>allowed.has(t));
 },[settings.noteFilter,settings.noteFilterValues,settings.accidentals,settings.keys]);
 const answerRows=useMemo(()=>['#','','b'].map(acc=>({acc,tokens:visibleAnswerTokens.filter(t=>tokenParts(t).acc===acc)})).filter(r=>r.tokens.length),[visibleAnswerTokens]);

 useEffect(()=>{
  const down=(e:KeyboardEvent)=>{if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName||''))return;if(e.key==='ArrowUp'){sharpHeld.current=true;return}if(e.key==='ArrowDown'){flatHeld.current=true;return}if(e.shiftKey&&e.key.toLowerCase()==='r'){e.preventDefault();reveal();return}if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();skip();return}if(e.shiftKey&&e.key.toLowerCase()==='p'){e.preventDefault();setReportOpen(true);return}const l=e.key.toUpperCase();if(LETTERS.includes(l)){e.preventDefault();answerToken(l+(sharpHeld.current?'#':flatHeld.current?'b':''))}};
  const up=(e:KeyboardEvent)=>{if(e.key==='ArrowUp')sharpHeld.current=false;if(e.key==='ArrowDown')flatHeld.current=false};document.addEventListener('keydown',down);document.addEventListener('keyup',up);return()=>{document.removeEventListener('keydown',down);document.removeEventListener('keyup',up)}
 });

 const cfg=question?CLEFS[question.clef]:CLEFS.treble,sig=question?KEYS[question.key]:KEYS.C,bottomY=190,half=10,x=515,y=question?bottomY-question.step*half:150;
 const ledger:number[]=[];if(question&&question.step<0)for(let s=-2;s>=question.step-(question.step%2!==0?1:0);s-=2)ledger.push(s);if(question&&question.step>8)for(let s=10;s<=question.step+(question.step%2!==0?1:0);s+=2)ledger.push(s);const viewTop=Math.min(0,y-48),viewBottom=Math.max(290,y+48),viewHeight=viewBottom-viewTop;
 const currentRange=question?settings.ranges[question.clef]:settings.ranges[settings.clefs[0]||'treble'],rangeText=`${midiName(currentRange.min)}–${midiName(currentRange.max)}`;
 const helperSteps=settings.positions==='lines'?[0,2,4,6,8]:settings.positions==='spaces'?[1,3,5,7]:[0,1,2,3,4,5,6,7,8];
 const challengeProgress=settings.challengeMode?(settings.questionLimit>0?`${Math.min(questions,settings.questionLimit)}/${settings.questionLimit}`:settings.timeLimitMinutes>0?`${fmt(remaining)} remaining`:'Unlimited challenge'):'Unlimited practice';

 return <section className="card exercise-app">
  <header className="exercise-top"><div><p className="eyebrow">Sight reading</p><h1>Note Reading Exercise</h1></div><div className="top-actions"><button onClick={()=>setReportOpen(true)}>Report</button><button onClick={()=>{setDraft(settings);setSettingsOpen(true)}}>Settings</button></div></header>
  <div className="stats"><div className="stat"><b>{correct}</b><span>Correct</span></div><div className="stat"><b>{questions}</b><span>Questions</span></div><div className="stat"><b>{accuracy===null?'—':`${accuracy}%`}</b><span>Accuracy</span></div><div className="stat"><b>{streak}</b><span>Streak</span></div><div className="stat"><b>{timeLimitMs?fmt(remaining):fmt(elapsed)}</b><span>Time</span></div></div>
  <div className="exercise-work"><div className="practice"><div className="practice-head"><span>{cfg.label} · {question?signatureLabel(question.key):'None'} · {rangeText}</span><button className="soft-btn" onClick={playTone}>♪ Hear</button></div><div className="staff-stage"><svg viewBox={`0 ${viewTop} 780 ${viewHeight}`} aria-label="Note reading question"><rect x="44" y="64" width="706" height="164" rx="18" fill="#fff" stroke="#edf1f5"/>{[0,1,2,3,4].map(i=><line key={i} x1="70" y1={bottomY-i*20} x2="735" y2={bottomY-i*20} stroke="#39485b" strokeWidth="1.6"/>)}<text x="110" y={cfg.glyphY} fontSize={cfg.glyphSize} textAnchor="middle" fill="#233247">{cfg.glyph}</text>{sig.count>0&&sig.type&&KEY_STEPS[question?.clef||'treble'][sig.type].slice(0,sig.count).map((step,i)=><text key={i} x={174+i*22} y={bottomY-step*half+10} fontSize="28" textAnchor="middle" fill="#4a596e">{accidental(sig.type)}</text>)}{ledger.map(s=><line key={s} x1={x-31} y1={bottomY-s*half} x2={x+31} y2={bottomY-s*half} stroke="#39485b" strokeWidth="1.7"/>)}{question?.written&&<text x={x-42} y={y+12} fontSize="40" textAnchor="middle">{accidental(question.written)}</text>}{question&&<ellipse cx={x} cy={y} rx="15" ry="10" fill="#fff" stroke="#172437" strokeWidth="3.1" transform={`rotate(-13 ${x} ${y})`}/>} {settings.helpers&&question&&helperSteps.map(step=>{const n=noteAt(cfg.bottom+step),token=n.letter+(sig.acc[n.letter]||'');return <text key={`h${step}`} x="730" y={bottomY-step*half+4} textAnchor="end" className="exercise-helper-label">{answerLabel(token,settings.noteNames,question.key)}</text>})}</svg></div><div className="question-status">{status}</div><div className="answer-grid music-theory-answers">{answerRows.flatMap(row=>row.tokens.map(token=>{const correctId=question?questionToken(question):'';return <button key={token} disabled={resolved||!question} className={resolved&&token===correctId?'correct':wrongAnswers.includes(token)?'wrong':''} onClick={()=>answerToken(token)}>{answerLabel(token,settings.noteNames,question?.key||settings.keys[0]||'C')}</button>}))}</div><div className="exercise-actions"><button onClick={reveal}>Reveal</button><button onClick={resetSession}>Reset</button><button onClick={skip}>New question</button></div></div><aside className="exercise-side"><div className="side-card"><h3>Current setup</h3><div className="summary"><div><span>Clefs</span><b>{settings.clefs.map(c=>CLEFS[c].label).join(', ')}</b></div><div><span>Positions</span><b>{settings.positions==='all'?'Lines + spaces':settings.positions==='lines'?'Lines only':'Spaces only'}</b></div><div><span>Key signatures</span><b>{settings.keys.length>3?`${settings.keys.slice(0,2).map(signatureLabel).join(', ')} +${settings.keys.length-2}`:settings.keys.map(signatureLabel).join(', ')}</b></div><div><span>Note names</span><b>{NOTE_NAME_OPTIONS.find(o=>o.value===settings.noteNames)?.short||'Letters'}</b></div><div><span>Accidentals</span><b>{settings.accidentals?'On':'Off'}</b></div><div><span>Note filter</span><b>{settings.noteFilter?`${settings.noteFilterValues.length} notes`:'Off'}</b></div></div><button className="primary" style={{marginTop:10}} onClick={()=>{setDraft(settings);setSettingsOpen(true)}}>Customize</button></div><div className="side-card challenge"><h3>Challenge · {challengeLabel}</h3><p>{ended?'Finished':challengeProgress}</p></div></aside></div>

  {settingsOpen&&<div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setSettingsOpen(false)}}><div className="drawer exercise-settings-drawer"><div className="drawer-head"><div><h2>Exercise settings</h2><p>Note Identification settings</p></div><button onClick={()=>setSettingsOpen(false)}>×</button></div>
   <SettingGroup label="Clefs"><p className="settings-help">Select one or more clefs.</p><div className="check-grid">{(Object.keys(CLEFS) as Clef[]).map(c=><button key={c} className={draft.clefs.includes(c)?'active':''} onClick={()=>toggleClef(c)}>{CLEFS[c].label}</button>)}</div></SettingGroup>
   <SettingGroup label="Range"><div className="range-stack">{draft.clefs.map(c=><div key={c} className="range-block"><div className="range-block-title"><b>{CLEFS[c].label} Range</b><span>{midiName(draft.ranges[c].min)}–{midiName(draft.ranges[c].max)}</span></div><StaffRangePicker clef={c} low={draft.ranges[c].min} high={draft.ranges[c].max} onChange={(min,max)=>setDraftRange(c,min,max)}/></div>)}</div></SettingGroup>
   <SettingGroup label="Positions"><div className="seg three"><button className={draft.positions==='all'?'active':''} onClick={()=>setDraft(d=>({...d,positions:'all'}))}>Lines + spaces</button><button className={draft.positions==='lines'?'active':''} onClick={()=>setDraft(d=>({...d,positions:'lines'}))}>Lines only</button><button className={draft.positions==='spaces'?'active':''} onClick={()=>setDraft(d=>({...d,positions:'spaces'}))}>Spaces only</button></div></SettingGroup>
   <SettingGroup label="Key Signatures"><p className="settings-help">Select any combination of signatures.</p><div className="key-signature-grid">{KEY_ORDER.map(k=><button key={k} className={draft.keys.includes(k)?'active':''} onClick={()=>toggleKey(k)}><b>{KEYS[k].count?`${KEYS[k].count}${KEYS[k].type==='b'?'♭':'♯'}`:'None'}</b><small>{KEYS[k].label}</small></button>)}</div></SettingGroup>
   <SettingGroup label="Note Names"><select value={draft.noteNames} onChange={e=>setDraft(d=>({...d,noteNames:e.target.value as NoteNameMode}))}>{NOTE_NAME_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></SettingGroup>
   <SettingGroup label="Helpers"><label className="toggle"><span>Show note-name helpers on the staff</span><input type="checkbox" checked={draft.helpers} onChange={e=>setDraft(d=>({...d,helpers:e.target.checked}))}/></label></SettingGroup>
   <SettingGroup label="Accidentals"><label className="toggle"><span>Add naturals, sharps, and flats to questions</span><input type="checkbox" checked={draft.accidentals} onChange={e=>setDraft(d=>({...d,accidentals:e.target.checked}))}/></label></SettingGroup>
   <SettingGroup label="Note Filter"><label className="toggle"><span>Limit questions and answer buttons to selected notes</span><input type="checkbox" checked={draft.noteFilter} onChange={e=>setDraft(d=>({...d,noteFilter:e.target.checked}))}/></label>{draft.noteFilter&&<div className="note-filter-grid">{['#','','b'].map(acc=><div key={acc||'n'} className="note-filter-row"><span>{acc==='#'?'Sharps':acc==='b'?'Flats':'Naturals'}</span><div>{NOTE_TOKENS.filter(t=>tokenParts(t).acc===acc).map(t=><button key={t} className={draft.noteFilterValues.includes(t)?'active':''} onClick={()=>toggleFilter(t)}>{t[0]}{accidental(acc)}</button>)}</div></div>)}</div>}</SettingGroup>
   <SettingGroup label="Next Question"><div className="seg two"><button className={draft.nextQuestion==='immediately'?'active':''} onClick={()=>setDraft(d=>({...d,nextQuestion:'immediately'}))}>Immediately</button><button className={draft.nextQuestion==='after-audio'?'active':''} onClick={()=>setDraft(d=>({...d,nextQuestion:'after-audio'}))}>After audio</button></div></SettingGroup>
   <SettingGroup label="Challenge Mode"><label className="toggle"><span>Challenge Mode</span><input type="checkbox" checked={draft.challengeMode} onChange={e=>setDraft(d=>({...d,challengeMode:e.target.checked}))}/></label>{draft.challengeMode&&<div className="challenge-settings-grid"><label><span>Time limit</span><div><input type="number" min="0" max="120" step="1" value={draft.timeLimitMinutes} onChange={e=>setDraft(d=>({...d,timeLimitMinutes:Math.max(0,+e.target.value||0)}))}/><small>minutes · 0 = Off</small></div></label><label><span>Question limit</span><div><input type="number" min="0" max="500" step="1" value={draft.questionLimit} onChange={e=>setDraft(d=>({...d,questionLimit:Math.max(0,Math.round(+e.target.value||0))}))}/><small>questions · 0 = Off</small></div></label><label className="toggle"><span>Multiple attempts</span><input type="checkbox" checked={draft.multiple} onChange={e=>setDraft(d=>({...d,multiple:e.target.checked}))}/></label></div>}</SettingGroup>
   <button className="primary" style={{marginTop:14}} onClick={apply}>Apply</button>
  </div></div>}

  {reportOpen&&<div className="report-modal" onMouseDown={e=>{if(e.target===e.currentTarget)setReportOpen(false)}}><div className="report-card"><h2>Progress report</h2><div className="report-grid"><div><b>{correct}</b><span>Correct</span></div><div><b>{questions}</b><span>Questions</span></div><div><b>{accuracy===null?'—':`${accuracy}%`}</b><span>Accuracy</span></div><div><b>{best}</b><span>Best streak</span></div><div><b>{fmt(elapsed)}</b><span>Elapsed</span></div><div><b>{challengeLabel}</b><span>Mode</span></div></div><div className="actions"><button className="soft-btn" onClick={()=>setReportOpen(false)}>Close</button><button className="primary" onClick={()=>{setReportOpen(false);resetSession()}}>Reset</button></div></div></div>}
 </section>
}

const NOTE_NAME_OPTIONS:{value:NoteNameMode;label:string;short:string}[]=[
 {value:'letters',label:'Letters',short:'Letters'},
 {value:'german',label:'German',short:'German'},
 {value:'fixed-do-ti',label:'Solfège (Fixed, Do–Ti)',short:'Fixed Do–Ti'},
 {value:'fixed-do-si',label:'Solfège (Fixed, Do–Si)',short:'Fixed Do–Si'},
 {value:'fixed-chromatic',label:'Solfège (Fixed, Chromatic)',short:'Fixed Chromatic'},
 {value:'movable-major-do',label:'Solfège (Movable, Major–Do)',short:'Movable Do'},
 {value:'movable-minor-la',label:'Solfège (Movable, Minor–La)',short:'Movable La'},
 {value:'scale-degrees',label:'Scale Degrees',short:'Scale Degrees'}
];

function ledgerSteps(step:number){const out:number[]=[];if(step<0)for(let s=-2;s>=step-(step%2!==0?1:0);s-=2)out.push(s);if(step>8)for(let s=10;s<=step+(step%2!==0?1:0);s+=2)out.push(s);return out}
function StaffRangePicker({clef,low,high,onChange}:{clef:Clef;low:number;high:number;onChange:(low:number,high:number)=>void}){
 const svgRef=useRef<SVGSVGElement|null>(null),dragRef=useRef<RangeHandle|null>(null),cfg=CLEFS[clef];
 const chartTop=42,chartBottom=378,firstIndex=14,lastIndex=49,stepY=(chartBottom-chartTop)/(lastIndex-firstIndex),yForIndex=(idx:number)=>chartBottom-(idx-firstIndex)*stepY,staffBottom=yForIndex(cfg.bottom),glyphY=staffBottom+(cfg.glyphY-190)*(stepY/10),glyphSize=cfg.glyphSize*(stepY/10),lowNote=rangeNote(low),highNote=rangeNote(high),lowStep=lowNote.index-cfg.bottom,highStep=highNote.index-cfg.bottom,lowY=yForIndex(lowNote.index),highY=yForIndex(highNote.index),noteX=(which:RangeHandle)=>which==='low'?330:440;
 const setFromY=(which:RangeHandle,clientY:number)=>{const rect=svgRef.current?.getBoundingClientRect();if(!rect)return;const localY=(clientY-rect.top)*(420/rect.height),idx=clamp(Math.round(firstIndex+(chartBottom-localY)/stepY),firstIndex,lastIndex),note=RANGE_NOTES.reduce((best,n)=>Math.abs(n.index-idx)<Math.abs(best.index-idx)?n:best,RANGE_NOTES[0]);if(which==='low')onChange(Math.min(note.midi,high),high);else onChange(low,Math.max(note.midi,low))};
 const start=(which:RangeHandle,e:ReactPointerEvent<SVGGElement>)=>{dragRef.current=which;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);setFromY(which,e.clientY)},move=(e:ReactPointerEvent<SVGGElement>)=>{if(dragRef.current)setFromY(dragRef.current,e.clientY)},end=(e:ReactPointerEvent<SVGGElement>)=>{dragRef.current=null;try{e.currentTarget.releasePointerCapture(e.pointerId)}catch{}},bump=(which:RangeHandle,dir:number)=>{const current=which==='low'?low:high,idx=Math.max(0,RANGE_NOTES.findIndex(n=>n.midi===current)),next=RANGE_NOTES[clamp(idx+dir,0,RANGE_NOTES.length-1)].midi;if(which==='low')onChange(Math.min(next,high),high);else onChange(low,Math.max(next,low))};
 const renderHandle=(which:RangeHandle,note:{letter:string;octave:number;midi:number;index:number},step:number,yPos:number)=>{const xPos=noteX(which),label=which==='low'?'From':'To',ledgers=ledgerSteps(step);return <g key={which} className={`staff-range-handle ${which}`} tabIndex={0} role="slider" aria-label={`${label} ${midiName(note.midi)}. Drag note up or down.`} aria-valuetext={midiName(note.midi)} onPointerDown={e=>start(which,e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={e=>{if(e.key==='ArrowUp'){e.preventDefault();bump(which,1)}else if(e.key==='ArrowDown'){e.preventDefault();bump(which,-1)}}}>{ledgers.map(s=><line key={s} x1={xPos-29} y1={staffBottom-s*stepY} x2={xPos+29} y2={staffBottom-s*stepY} className="staff-range-ledger"/>)}<ellipse cx={xPos} cy={yPos} rx="15" ry="10" transform={`rotate(-13 ${xPos} ${yPos})`} className="staff-range-head"/><line x1={xPos+13} y1={yPos-2} x2={xPos+13} y2={yPos-37} className="staff-range-stem"/><g transform={`translate(${xPos-39} ${which==='low'?Math.min(394,yPos+18):Math.max(18,yPos-48)})`}><rect width="78" height="24" rx="12" className="staff-range-label-bg"/><text x="39" y="16" textAnchor="middle" className="staff-range-label-text">{label} {midiName(note.midi)}</text></g></g>};
 return <div className="staff-range-picker"><div className="staff-range-readout"><span><small>From</small><b>{midiName(low)}</b></span><i>→</i><span><small>To</small><b>{midiName(high)}</b></span></div><div className="staff-range-practice"><div className="staff-range-caption"><b>{cfg.label} clef</b><span>Drag the two notes on the staff</span></div><svg ref={svgRef} viewBox="0 0 620 420" aria-label={`${cfg.label} clef range ${midiName(low)} to ${midiName(high)}`}><rect x="20" y="18" width="580" height="384" rx="18" className="staff-range-sheet"/><rect x="302" y={Math.min(lowY,highY)} width="166" height={Math.max(4,Math.abs(lowY-highY))} rx="18" className="staff-range-selection"/>{[0,1,2,3,4].map(i=><line key={i} x1="58" y1={staffBottom-i*2*stepY} x2="566" y2={staffBottom-i*2*stepY} className="staff-range-line"/>)}<text x="112" y={glyphY} fontSize={glyphSize} textAnchor="middle" className="staff-range-clef">{cfg.glyph}</text>{renderHandle('low',lowNote,lowStep,lowY)}{renderHandle('high',highNote,highStep,highY)}</svg></div><p className="staff-range-help">Set the exact practice range on the same clef staff. Available audio: C2–C7.</p></div>
}
function SettingGroup({label,children}:{label:string;children:ReactNode}){return <div className="settings-group"><label>{label}</label>{children}</div>}
