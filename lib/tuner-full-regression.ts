import { PitchDetector } from 'pitchy';
import { noteFromFrequency, rms } from './music';
import { detectMpm } from './mpm';
import {
  PitchTracker,
  centsApart,
  chooseHarmonicCandidate,
  detectorRangeForSampleRate,
  type PitchCandidate,
  type PitchMode,
  type PitchTrackResult
} from './pitch-engine';
import {
  SYNTHETIC_FRAME_SIZE,
  SYNTHETIC_SAMPLE_RATE,
  buildSyntheticPitchCases,
  mixSynthetic,
  syntheticHarmonicTone,
  syntheticNoise,
  syntheticSine
} from './pitch-regression';
import { prepareSensitiveFrame, segmentRms } from './tuner-signal';
import { spectrumDbFromSamples } from './tuner-spectrum';
import { detectPitch } from './yin';

const LONG_SIZE=8192;
const SHORT_SIZE=4096;
const FAST_SIZE=2048;
const DEFAULT_HOP_SIZE=1024;
const FRAME_STEP_MS=DEFAULT_HOP_SIZE/SYNTHETIC_SAMPLE_RATE*1000;

export type FullTunerFrameResult={
  now:number;
  fusedFrequency:number|null;
  fusedClarity:number;
  tracked:PitchTrackResult;
  note:string|null;
  centsFromExpected:number|null;
};

export type FullStaticRegressionResult={
  name:string;
  expectedHz:number|null;
  expectedNote:string|null;
  finalFrequency:number|null;
  finalNote:string|null;
  finalCentsError:number|null;
  firstLockMs:number|null;
  lockedFrames:number;
  falsePositiveFrames:number;
  octaveErrorFrames:number;
  pass:boolean;
};

export type FullTemporalRegressionResult={
  name:string;
  pass:boolean;
  finalNote:string|null;
  switchLatencyMs:number|null;
  dropoutHeldFrames:number;
  releaseSeen:boolean;
  idleSeenAfterRelease:boolean;
  falsePositiveFrames:number;
};

export type FullTunerRegressionReport={
  sampleRate:number;
  frameStepMs:number;
  staticCases:FullStaticRegressionResult[];
  temporalCases:FullTemporalRegressionResult[];
  summary:{
    staticPassed:number;
    staticTotal:number;
    temporalPassed:number;
    temporalTotal:number;
    falsePositiveFrames:number;
    octaveErrorFrames:number;
    pass:boolean;
  };
};

function tail(input:Float32Array,size:number){
  if(input.length===size)return input;
  return input.subarray(Math.max(0,input.length-size));
}

function scaledCopy(input:Float32Array,gain:number){
  const output=new Float32Array(input.length);
  for(let i=0;i<input.length;i++)output[i]=input[i]*gain;
  return output;
}

function silence(){
  return new Float32Array(SYNTHETIC_FRAME_SIZE);
}

function centsError(actual:number,expected:number){
  return 1200*Math.log2(actual/expected);
}

function isOctaveError(actual:number,expected:number){
  if(!(actual>0)||!(expected>0))return false;
  const octaves=Math.round(Math.log2(actual/expected));
  if(octaves===0)return false;
  const corrected=actual/Math.pow(2,octaves);
  return Math.abs(centsError(corrected,expected))<=55;
}

export class FullTunerHarness{
  private readonly longDetector=PitchDetector.forFloat32Array(LONG_SIZE);
  private readonly shortDetector=PitchDetector.forFloat32Array(SHORT_SIZE);
  private readonly fastDetector=PitchDetector.forFloat32Array(FAST_SIZE);
  private readonly tracker=new PitchTracker();
  private readonly longPrepared=new Float32Array(LONG_SIZE);
  private readonly shortPrepared=new Float32Array(SHORT_SIZE);
  private readonly fastPrepared=new Float32Array(FAST_SIZE);
  private readonly range:ReturnType<typeof detectorRangeForSampleRate>;

  constructor(
    readonly sampleRate=SYNTHETIC_SAMPLE_RATE,
    readonly a4=440
  ){
    this.range=detectorRangeForSampleRate(sampleRate);
    this.longDetector.minVolumeAbsolute=0;
    this.longDetector.clarityThreshold=.22;
    this.shortDetector.minVolumeAbsolute=0;
    this.shortDetector.clarityThreshold=.18;
    this.fastDetector.minVolumeAbsolute=0;
    this.fastDetector.clarityThreshold=.16;
  }

  reset(){
    this.tracker.reset();
  }

  process(
    samples:Float32Array,
    now:number,
    expectedHz:number|null=null
  ):FullTunerFrameResult{
    if(samples.length<FAST_SIZE)throw new Error('Full tuner regression frame must contain at least 2048 samples');

    const longRaw=samples.length>=LONG_SIZE?tail(samples,LONG_SIZE):null;
    const shortRaw=samples.length>=SHORT_SIZE?tail(samples,SHORT_SIZE):null;
    const fastRaw=tail(samples,FAST_SIZE);

    if(longRaw)prepareSensitiveFrame(longRaw,this.longPrepared);
    if(shortRaw)prepareSensitiveFrame(shortRaw,this.shortPrepared);
    prepareSensitiveFrame(fastRaw,this.fastPrepared);

    const [longFrequency,longClarity]=longRaw
      ?this.longDetector.findPitch(this.longPrepared,this.sampleRate)
      :[0,0];
    const [shortFrequency,shortClarity]=shortRaw
      ?this.shortDetector.findPitch(this.shortPrepared,this.sampleRate)
      :[0,0];
    const [fastFrequency,fastClarity]=this.fastDetector.findPitch(this.fastPrepared,this.sampleRate);

    const lowCandidate=longFrequency>0&&longFrequency<90;
    const yinInput=lowCandidate&&longRaw
      ?this.longPrepared
      :shortRaw
        ?this.shortPrepared
        :null;
    const yin=yinInput
      ?detectPitch(
        yinInput,
        this.sampleRate,
        lowCandidate?this.range.min:Math.max(55,this.range.min),
        this.range.max
      )
      :null;

    const hint=shortFrequency>0?shortFrequency:fastFrequency>0?fastFrequency:longFrequency;
    const lowMpm=hint>0&&hint<220;
    const mpmInput=lowMpm&&shortRaw?this.shortPrepared:this.fastPrepared;
    const mpm=hint>=70
      ?detectMpm(
        mpmInput,
        this.sampleRate,
        lowMpm?Math.max(70,this.range.min):Math.max(180,this.range.min),
        this.range.max
      )
      :null;

    const recentRms=segmentRms(fastRaw,FAST_SIZE-512,FAST_SIZE);
    const previousRms=segmentRms(fastRaw,0,FAST_SIZE-512);
    const onset=recentRms>Math.max(previousRms*1.18,previousRms+.00018);
    const useFast=
      fastFrequency>0&&
      (onset||fastFrequency>=500)&&
      fastClarity>=shortClarity*.86;
    const responsiveFrequency=useFast?fastFrequency:shortFrequency;
    const responsiveClarity=useFast?fastClarity:shortClarity;

    const consensus:PitchCandidate[]=[];
    if(yin)consensus.push({frequency:yin.frequency,clarity:yin.clarity,mode:'sustained'});
    if(mpm)consensus.push({frequency:mpm.frequency,clarity:mpm.clarity,mode:'sustained'});

    const fastShortAgree=
      fastFrequency>0&&shortFrequency>0&&
      centsApart(fastFrequency,shortFrequency)<=45;
    const suppressLong=
      onset&&fastShortAgree&&responsiveFrequency>0&&
      longFrequency>0&&centsApart(longFrequency,responsiveFrequency)>80;
    const freshConsensus=consensus.filter(candidate=>
      !(onset&&fastShortAgree&&responsiveFrequency>0&&centsApart(candidate.frequency,responsiveFrequency)>80)
    );

    const spectrum=spectrumDbFromSamples(
      longRaw?this.longPrepared:shortRaw?this.shortPrepared:this.fastPrepared
    );
    const mode:PitchMode=onset?'transient':'sustained';
    const picked=chooseHarmonicCandidate(
      {
        frequency:!suppressLong&&longFrequency>0?longFrequency:0,
        clarity:!suppressLong?longClarity:0,
        mode:'sustained'
      },
      {
        frequency:responsiveFrequency>0?responsiveFrequency:0,
        clarity:responsiveClarity,
        mode
      },
      freshConsensus,
      spectrum,
      this.sampleRate,
      this.range.min,
      this.range.max
    );

    const lowNeedsLongSupport=
      picked.frequency>0&&picked.frequency<80&&
      (!longRaw||suppressLong||centsApart(longFrequency,picked.frequency)>45)&&
      !freshConsensus.some(candidate=>centsApart(candidate.frequency,picked.frequency)<=45);

    const fusedFrequency=lowNeedsLongSupport?0:picked.frequency;
    const fusedClarity=lowNeedsLongSupport?0:picked.clarity;
    const tracked=this.tracker.accept({
      frequency:fusedFrequency,
      clarity:fusedClarity,
      rms:rms(fastRaw),
      mode:picked.mode,
      now
    });

    const note=tracked.frequency?noteFromFrequency(tracked.frequency,this.a4).label:null;
    return{
      now,
      fusedFrequency:fusedFrequency>0?fusedFrequency:null,
      fusedClarity,
      tracked,
      note,
      centsFromExpected:
        tracked.frequency&&expectedHz
          ?centsError(tracked.frequency,expectedHz)
          :null
    };
  }
}

export function tunerFrameStepMs(sampleRate:number,hopSize=DEFAULT_HOP_SIZE){
  return hopSize/sampleRate*1000;
}

export function processProgressiveAudio(
  engine:FullTunerHarness,
  samples:Float32Array,
  {
    hopSize=DEFAULT_HOP_SIZE,
    startSample=0,
    endSample=samples.length,
    expectedHz=null,
    onFrame
  }:{
    hopSize?:number;
    startSample?:number;
    endSample?:number;
    expectedHz?:number|null;
    onFrame?:(result:FullTunerFrameResult,endSample:number)=>void;
  }={}
){
  const safeStart=Math.max(0,Math.floor(startSample));
  const safeEnd=Math.min(samples.length,Math.max(safeStart,Math.floor(endSample)));
  const firstEnd=Math.max(safeStart+FAST_SIZE,FAST_SIZE);
  const frameStep=tunerFrameStepMs(engine.sampleRate,hopSize);
  const results:FullTunerFrameResult[]=[];

  for(let end=firstEnd;end<=safeEnd;end+=hopSize){
    const windowStart=Math.max(0,end-LONG_SIZE);
    const frame=samples.subarray(windowStart,end);
    if(frame.length<FAST_SIZE)continue;
    const now=end/engine.sampleRate*1000;
    const result=engine.process(frame,now,expectedHz);
    results.push(result);
    onFrame?.(result,end);
  }
  return {results,frameStepMs:frameStep};
}

function warmNoiseFrames(engine:FullTunerHarness,startNow=0){
  const noise=scaledCopy(syntheticNoise(SYNTHETIC_FRAME_SIZE,0x7107a11),.004);
  let now=startNow;
  for(let i=0;i<5;i++){
    engine.process(noise,now,null);
    now+=FRAME_STEP_MS;
  }
  return now;
}

function runStaticCase(
  testCase:ReturnType<typeof buildSyntheticPitchCases>[number]
):FullStaticRegressionResult{
  const engine=new FullTunerHarness();
  let now=warmNoiseFrames(engine);
  const toneStart=now;
  let firstLockMs:number|null=null;
  let lockedFrames=0;
  let falsePositiveFrames=0;
  let octaveErrorFrames=0;
  let last:FullTunerFrameResult|null=null;

  const frames=testCase.expectedHz===null?16:10;
  for(let i=0;i<frames;i++){
    const result=engine.process(testCase.samples,now,testCase.expectedHz);
    last=result;

    if(result.tracked.frequency){
      lockedFrames++;
      if(firstLockMs===null)firstLockMs=now-toneStart;
      if(testCase.expectedHz===null)falsePositiveFrames++;
      else if(isOctaveError(result.tracked.frequency,testCase.expectedHz))octaveErrorFrames++;
    }
    now+=FRAME_STEP_MS;
  }

  const expectedNote=testCase.expectedHz
    ?noteFromFrequency(testCase.expectedHz).label
    :null;
  const finalFrequency=last?.tracked.frequency??null;
  const finalNote=finalFrequency?noteFromFrequency(finalFrequency).label:null;
  const finalCentsError=
    finalFrequency&&testCase.expectedHz
      ?centsError(finalFrequency,testCase.expectedHz)
      :null;

  const pass=testCase.expectedHz===null
    ?falsePositiveFrames===0
    :(
      finalNote===expectedNote&&
      finalCentsError!==null&&
      Math.abs(finalCentsError)<=testCase.maxCents&&
      octaveErrorFrames===0
    );

  return{
    name:testCase.name,
    expectedHz:testCase.expectedHz,
    expectedNote,
    finalFrequency,
    finalNote,
    finalCentsError,
    firstLockMs,
    lockedFrames,
    falsePositiveFrames,
    octaveErrorFrames,
    pass
  };
}

function runTransitionCase():FullTemporalRegressionResult{
  const engine=new FullTunerHarness();
  let now=warmNoiseFrames(engine);
  const a4=syntheticHarmonicTone(440,[.42,1,.70,.48,.31,.20]);
  const b4=syntheticHarmonicTone(493.8833,[.38,1,.74,.50,.32,.20]);

  for(let i=0;i<8;i++){
    engine.process(a4,now,440);
    now+=FRAME_STEP_MS;
  }

  const switchStart=now;
  let switchLatencyMs:number|null=null;
  let last:FullTunerFrameResult|null=null;
  for(let i=0;i<8;i++){
    const result=engine.process(b4,now,493.8833);
    last=result;
    if(switchLatencyMs===null&&result.note==='B4')switchLatencyMs=now-switchStart;
    now+=FRAME_STEP_MS;
  }

  const finalNote=last?.note??null;
  return{
    name:'A4 to B4 note transition',
    pass:finalNote==='B4'&&switchLatencyMs!==null&&switchLatencyMs<=150,
    finalNote,
    switchLatencyMs,
    dropoutHeldFrames:0,
    releaseSeen:false,
    idleSeenAfterRelease:false,
    falsePositiveFrames:0
  };
}

function runDropoutCase():FullTemporalRegressionResult{
  const engine=new FullTunerHarness();
  let now=warmNoiseFrames(engine);
  const a4=syntheticHarmonicTone(440,[.44,1,.72,.46,.29,.18]);

  for(let i=0;i<8;i++){
    engine.process(a4,now,440);
    now+=FRAME_STEP_MS;
  }

  let held=0;
  for(let i=0;i<5;i++){
    const result=engine.process(silence(),now,440);
    if(result.tracked.held&&result.tracked.frequency)held++;
    now+=FRAME_STEP_MS;
  }

  let last:FullTunerFrameResult|null=null;
  for(let i=0;i<4;i++){
    last=engine.process(a4,now,440);
    now+=FRAME_STEP_MS;
  }

  return{
    name:'A4 brief dropout hold and recovery',
    pass:held===5&&last?.note==='A4',
    finalNote:last?.note??null,
    switchLatencyMs:null,
    dropoutHeldFrames:held,
    releaseSeen:false,
    idleSeenAfterRelease:false,
    falsePositiveFrames:0
  };
}

function runReleaseCase():FullTemporalRegressionResult{
  const engine=new FullTunerHarness();
  let now=warmNoiseFrames(engine);
  const a4=syntheticHarmonicTone(440,[.44,1,.72,.46,.29,.18]);

  for(let i=0;i<8;i++){
    engine.process(a4,now,440);
    now+=FRAME_STEP_MS;
  }

  let releaseSeen=false;
  let idleSeenAfterRelease=false;
  let last:FullTunerFrameResult|null=null;
  for(let i=0;i<16;i++){
    const result=engine.process(silence(),now,440);
    last=result;
    if(result.tracked.state==='release')releaseSeen=true;
    if(releaseSeen&&result.tracked.state==='idle')idleSeenAfterRelease=true;
    now+=FRAME_STEP_MS;
  }

  return{
    name:'A4 release to idle',
    pass:releaseSeen&&idleSeenAfterRelease&&!last?.tracked.frequency,
    finalNote:last?.note??null,
    switchLatencyMs:null,
    dropoutHeldFrames:0,
    releaseSeen,
    idleSeenAfterRelease,
    falsePositiveFrames:0
  };
}

function runHumOnlyCase():FullTemporalRegressionResult{
  const engine=new FullTunerHarness();
  let now=warmNoiseFrames(engine);
  const hum=mixSynthetic(
    syntheticSine(50,.8),
    [{samples:syntheticNoise(SYNTHETIC_FRAME_SIZE,0x1150),gain:.025}]
  );
  let falsePositiveFrames=0;
  let last:FullTunerFrameResult|null=null;

  for(let i=0;i<18;i++){
    const result=engine.process(hum,now,null);
    last=result;
    if(result.tracked.frequency)falsePositiveFrames++;
    now+=FRAME_STEP_MS;
  }

  return{
    name:'Persistent 50 Hz hum remains unpitched',
    pass:falsePositiveFrames===0,
    finalNote:last?.note??null,
    switchLatencyMs:null,
    dropoutHeldFrames:0,
    releaseSeen:false,
    idleSeenAfterRelease:last?.tracked.state==='idle',
    falsePositiveFrames
  };
}

export function runFullTunerRegression():FullTunerRegressionReport{
  const staticCases=buildSyntheticPitchCases().map(runStaticCase);
  const temporalCases=[
    runTransitionCase(),
    runDropoutCase(),
    runReleaseCase(),
    runHumOnlyCase()
  ];

  const staticPassed=staticCases.filter(result=>result.pass).length;
  const temporalPassed=temporalCases.filter(result=>result.pass).length;
  const falsePositiveFrames=
    staticCases.reduce((sum,result)=>sum+result.falsePositiveFrames,0)+
    temporalCases.reduce((sum,result)=>sum+result.falsePositiveFrames,0);
  const octaveErrorFrames=staticCases.reduce((sum,result)=>sum+result.octaveErrorFrames,0);

  return{
    sampleRate:SYNTHETIC_SAMPLE_RATE,
    frameStepMs:FRAME_STEP_MS,
    staticCases,
    temporalCases,
    summary:{
      staticPassed,
      staticTotal:staticCases.length,
      temporalPassed,
      temporalTotal:temporalCases.length,
      falsePositiveFrames,
      octaveErrorFrames,
      pass:
        staticPassed===staticCases.length&&
        temporalPassed===temporalCases.length&&
        falsePositiveFrames===0&&
        octaveErrorFrames===0
    }
  };
}
