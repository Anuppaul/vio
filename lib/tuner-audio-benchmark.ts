import { midiFrequency, noteFromFrequency } from './music';
import {
  FullTunerHarness,
  tunerFrameStepMs,
  type FullTunerFrameResult
} from './tuner-full-regression';
import {
  isPitchOctaveError,
  mean,
  median,
  percentile,
  pitchCentsError,
  ratio
} from './tuner-metrics';

export type TunerBenchmarkCriteria={
  minVoicedFrameAccuracy?:number;
  minVoicedNoteAccuracy?:number;
  minVoicedDetectionRate?:number;
  maxDropoutRate?:number;
  maxVoicedCentsMae?:number;
  maxVoicedCentsP95?:number;
  maxOctaveErrorRate?:number;
  maxGrossErrorRate?:number;
  maxUnvoicedFalsePositiveRate?:number;
  minLockSuccessRate?:number;
  maxMedianLockMs?:number;
};

export type TunerBenchmarkDefaults={
  a4?:number;
  hopSize?:number;
  toleranceCents?:number;
  ignoreAttackMs?:number;
};

export type TunerBenchmarkRegion={
  id?:string;
  label?:string;
  startMs:number;
  endMs:number;
  voiced:boolean;
  expectedHz?:number;
  expectedMidi?:number;
  toleranceCents?:number;
  ignoreAttackMs?:number;
};

export type TunerBenchmarkRecording={
  id:string;
  file:string;
  tags?:string[];
  a4?:number;
  metadata?:Record<string,string|number|boolean>;
  regions:TunerBenchmarkRegion[];
};

export type TunerBenchmarkManifest={
  version:1;
  defaults?:TunerBenchmarkDefaults;
  criteria?:TunerBenchmarkCriteria;
  recordings:TunerBenchmarkRecording[];
};

export type TunerBenchmarkRegionReport={
  id:string;
  label:string;
  voiced:boolean;
  startMs:number;
  endMs:number;
  expectedHz:number|null;
  expectedNote:string|null;
  toleranceCents:number|null;
  totalFrames:number;
  scoredFrames:number;
  detectedFrames:number;
  correctFrames:number;
  noteCorrectFrames:number;
  falsePositiveFrames:number;
  dropoutFrames:number;
  octaveErrorFrames:number;
  grossErrorFrames:number;
  detectionRate:number;
  frameAccuracy:number;
  noteAccuracy:number;
  dropoutRate:number;
  falsePositiveRate:number;
  octaveErrorRate:number;
  grossErrorRate:number;
  centsMae:number|null;
  centsMedian:number|null;
  centsP95:number|null;
  firstCorrectMs:number|null;
  lockLatencyMs:number|null;
  finalNote:string|null;
  pass:boolean|null;
};

export type TunerBenchmarkAggregate={
  recordings:number;
  regions:number;
  voicedRegions:number;
  unvoicedRegions:number;
  scoredFrames:number;
  voicedFrames:number;
  unvoicedFrames:number;
  detectedVoicedFrames:number;
  correctVoicedFrames:number;
  noteCorrectVoicedFrames:number;
  falsePositiveFrames:number;
  dropoutFrames:number;
  octaveErrorFrames:number;
  grossErrorFrames:number;
  voicedDetectionRate:number;
  voicedFrameAccuracy:number;
  voicedNoteAccuracy:number;
  dropoutRate:number;
  unvoicedFalsePositiveRate:number;
  octaveErrorRate:number;
  grossErrorRate:number;
  lockSuccessRate:number;
  centsMae:number|null;
  centsMedian:number|null;
  centsP95:number|null;
  medianLockMs:number|null;
};

export type TunerBenchmarkRecordingReport={
  id:string;
  file:string;
  sampleRate:number;
  durationMs:number;
  channels?:number;
  bitsPerSample?:number;
  tags:string[];
  metadata:Record<string,string|number|boolean>;
  regions:TunerBenchmarkRegionReport[];
  aggregate:TunerBenchmarkAggregate;
  pass:boolean|null;
};

export type TunerBenchmarkReport={
  version:1;
  criteria:TunerBenchmarkCriteria|null;
  recordings:TunerBenchmarkRecordingReport[];
  aggregate:TunerBenchmarkAggregate;
  byTag:Record<string,TunerBenchmarkAggregate>;
  pass:boolean|null;
};

export type TunerBenchmarkAudio={
  sampleRate:number;
  samples:Float32Array;
  channels?:number;
  bitsPerSample?:number;
};

type RegionAccumulator={
  report:TunerBenchmarkRegionReport;
  absCents:number[];
  lastFrame:FullTunerFrameResult|null;
};

const recordingCents=new WeakMap<TunerBenchmarkRecordingReport,number[]>();

const DEFAULT_A4=440;
const DEFAULT_HOP_SIZE=1024;
const DEFAULT_TOLERANCE_CENTS=20;
const DEFAULT_IGNORE_ATTACK_MS=0;

function assertFiniteNumber(value:unknown,name:string){
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${name} must be a finite number`);
  return value;
}

function clampUnit(value:number,name:string){
  if(value<0||value>1)throw new Error(`${name} must be between 0 and 1`);
  return value;
}

function normalizeCriteria(input:unknown):TunerBenchmarkCriteria|undefined{
  if(input===undefined)return undefined;
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('criteria must be an object');
  const source=input as Record<string,unknown>;
  const result:TunerBenchmarkCriteria={};

  const unitKeys=[
    'minVoicedFrameAccuracy',
    'minVoicedNoteAccuracy',
    'minVoicedDetectionRate',
    'maxDropoutRate',
    'maxOctaveErrorRate',
    'maxGrossErrorRate',
    'maxUnvoicedFalsePositiveRate',
    'minLockSuccessRate'
  ] as const;
  for(const key of unitKeys){
    if(source[key]!==undefined)result[key]=clampUnit(assertFiniteNumber(source[key],`criteria.${key}`),`criteria.${key}`);
  }
  for(const key of ['maxVoicedCentsMae','maxVoicedCentsP95','maxMedianLockMs'] as const){
    if(source[key]!==undefined){
      const value=assertFiniteNumber(source[key],`criteria.${key}`);
      if(value<0)throw new Error(`criteria.${key} must be non-negative`);
      result[key]=value;
    }
  }
  return result;
}

function normalizeDefaults(input:unknown):TunerBenchmarkDefaults{
  if(input===undefined)return{};
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('defaults must be an object');
  const source=input as Record<string,unknown>;
  const result:TunerBenchmarkDefaults={};
  for(const key of ['a4','hopSize','toleranceCents','ignoreAttackMs'] as const){
    if(source[key]!==undefined)result[key]=assertFiniteNumber(source[key],`defaults.${key}`);
  }
  if(result.a4!==undefined&&(result.a4<400||result.a4>480))throw new Error('defaults.a4 must be between 400 and 480 Hz');
  if(result.hopSize!==undefined&&result.hopSize<128)throw new Error('defaults.hopSize must be at least 128 samples');
  if(result.toleranceCents!==undefined&&(result.toleranceCents<=0||result.toleranceCents>50))throw new Error('defaults.toleranceCents must be in (0, 50]');
  if(result.ignoreAttackMs!==undefined&&result.ignoreAttackMs<0)throw new Error('defaults.ignoreAttackMs must be non-negative');
  return result;
}

export function normalizeTunerBenchmarkManifest(input:unknown):TunerBenchmarkManifest{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Benchmark manifest must be an object');
  const source=input as Record<string,unknown>;
  if(source.version!==1)throw new Error('Benchmark manifest version must be 1');
  if(!Array.isArray(source.recordings)||!source.recordings.length)throw new Error('Benchmark manifest needs at least one recording');

  const defaults=normalizeDefaults(source.defaults);
  const criteria=normalizeCriteria(source.criteria);
  const seenRecordings=new Set<string>();

  const recordings:TunerBenchmarkRecording[]=source.recordings.map((rawRecording,index)=>{
    if(!rawRecording||typeof rawRecording!=='object'||Array.isArray(rawRecording))throw new Error(`recordings[${index}] must be an object`);
    const recording=rawRecording as Record<string,unknown>;
    const id=String(recording.id??'').trim();
    const file=String(recording.file??'').trim();
    if(!id)throw new Error(`recordings[${index}].id is required`);
    if(seenRecordings.has(id))throw new Error(`Duplicate recording id: ${id}`);
    seenRecordings.add(id);
    if(!file)throw new Error(`recordings[${index}].file is required`);
    if(!Array.isArray(recording.regions)||!recording.regions.length)throw new Error(`recordings[${index}].regions must not be empty`);

    const a4=recording.a4===undefined?undefined:assertFiniteNumber(recording.a4,`recordings[${index}].a4`);
    if(a4!==undefined&&(a4<400||a4>480))throw new Error(`recordings[${index}].a4 must be between 400 and 480 Hz`);

    const tags=recording.tags===undefined?[]:
      Array.isArray(recording.tags)
        ?recording.tags.map((tag,tagIndex)=>{
          if(typeof tag!=='string'||!tag.trim())throw new Error(`recordings[${index}].tags[${tagIndex}] must be a non-empty string`);
          return tag.trim();
        })
        :(()=>{throw new Error(`recordings[${index}].tags must be an array`)})();

    const metadata:Record<string,string|number|boolean>={};
    if(recording.metadata!==undefined){
      if(!recording.metadata||typeof recording.metadata!=='object'||Array.isArray(recording.metadata))throw new Error(`recordings[${index}].metadata must be an object`);
      for(const [key,value] of Object.entries(recording.metadata as Record<string,unknown>)){
        if(!['string','number','boolean'].includes(typeof value))throw new Error(`recordings[${index}].metadata.${key} must be string, number, or boolean`);
        metadata[key]=value as string|number|boolean;
      }
    }

    let previousEnd=-Infinity;
    const regions:TunerBenchmarkRegion[]=recording.regions.map((rawRegion,regionIndex)=>{
      if(!rawRegion||typeof rawRegion!=='object'||Array.isArray(rawRegion))throw new Error(`recordings[${index}].regions[${regionIndex}] must be an object`);
      const region=rawRegion as Record<string,unknown>;
      const startMs=assertFiniteNumber(region.startMs,`recordings[${index}].regions[${regionIndex}].startMs`);
      const endMs=assertFiniteNumber(region.endMs,`recordings[${index}].regions[${regionIndex}].endMs`);
      if(startMs<0||endMs<=startMs)throw new Error(`recordings[${index}].regions[${regionIndex}] has invalid time range`);
      if(startMs<previousEnd)throw new Error(`recordings[${index}] regions must be sorted and non-overlapping`);
      previousEnd=endMs;
      if(typeof region.voiced!=='boolean')throw new Error(`recordings[${index}].regions[${regionIndex}].voiced must be boolean`);

      const normalized:TunerBenchmarkRegion={
        startMs,
        endMs,
        voiced:region.voiced
      };
      if(region.id!==undefined)normalized.id=String(region.id);
      if(region.label!==undefined)normalized.label=String(region.label);
      if(region.expectedHz!==undefined)normalized.expectedHz=assertFiniteNumber(region.expectedHz,`recordings[${index}].regions[${regionIndex}].expectedHz`);
      if(region.expectedMidi!==undefined)normalized.expectedMidi=assertFiniteNumber(region.expectedMidi,`recordings[${index}].regions[${regionIndex}].expectedMidi`);
      if(region.toleranceCents!==undefined)normalized.toleranceCents=assertFiniteNumber(region.toleranceCents,`recordings[${index}].regions[${regionIndex}].toleranceCents`);
      if(region.ignoreAttackMs!==undefined)normalized.ignoreAttackMs=assertFiniteNumber(region.ignoreAttackMs,`recordings[${index}].regions[${regionIndex}].ignoreAttackMs`);

      if(normalized.voiced){
        const specified=Number(normalized.expectedHz!==undefined)+Number(normalized.expectedMidi!==undefined);
        if(specified!==1)throw new Error(`Voiced region recordings[${index}].regions[${regionIndex}] must specify exactly one of expectedHz or expectedMidi`);
        if(normalized.expectedHz!==undefined&&normalized.expectedHz<=0)throw new Error('expectedHz must be positive');
        if(normalized.expectedMidi!==undefined&&(normalized.expectedMidi<0||normalized.expectedMidi>127))throw new Error('expectedMidi must be in [0, 127]');
        const tolerance=normalized.toleranceCents??defaults.toleranceCents??DEFAULT_TOLERANCE_CENTS;
        if(tolerance<=0||tolerance>50)throw new Error('toleranceCents must be in (0, 50]');
        normalized.toleranceCents=tolerance;
      }
      const ignore=normalized.ignoreAttackMs??defaults.ignoreAttackMs??DEFAULT_IGNORE_ATTACK_MS;
      if(ignore<0)throw new Error('ignoreAttackMs must be non-negative');
      normalized.ignoreAttackMs=ignore;
      return normalized;
    });

    return{id,file,tags,a4,metadata,regions};
  });

  return{version:1,defaults,criteria,recordings};
}

function expectedFrequency(region:TunerBenchmarkRegion,a4:number){
  if(!region.voiced)return null;
  if(region.expectedHz!==undefined)return region.expectedHz;
  if(region.expectedMidi!==undefined)return midiFrequency(region.expectedMidi,a4);
  return null;
}

function createRegionAccumulator(
  recordingId:string,
  region:TunerBenchmarkRegion,
  regionIndex:number,
  a4:number
):RegionAccumulator{
  const expectedHz=expectedFrequency(region,a4);
  const expectedNote=expectedHz?noteFromFrequency(expectedHz,a4).label:null;
  return{
    report:{
      id:region.id||`${recordingId}:region-${regionIndex+1}`,
      label:region.label||expectedNote||(region.voiced?'voiced':'unvoiced'),
      voiced:region.voiced,
      startMs:region.startMs,
      endMs:region.endMs,
      expectedHz,
      expectedNote,
      toleranceCents:region.voiced?(region.toleranceCents??DEFAULT_TOLERANCE_CENTS):null,
      totalFrames:0,
      scoredFrames:0,
      detectedFrames:0,
      correctFrames:0,
      noteCorrectFrames:0,
      falsePositiveFrames:0,
      dropoutFrames:0,
      octaveErrorFrames:0,
      grossErrorFrames:0,
      detectionRate:0,
      frameAccuracy:0,
      noteAccuracy:0,
      dropoutRate:0,
      falsePositiveRate:0,
      octaveErrorRate:0,
      grossErrorRate:0,
      centsMae:null,
      centsMedian:null,
      centsP95:null,
      firstCorrectMs:null,
      lockLatencyMs:null,
      finalNote:null,
      pass:null
    },
    absCents:[],
    lastFrame:null
  };
}

function finalizeRegion(
  accumulator:RegionAccumulator,
  region:TunerBenchmarkRegion,
  criteria:TunerBenchmarkCriteria|undefined
){
  const report=accumulator.report;
  report.detectionRate=ratio(report.detectedFrames,report.scoredFrames);
  report.frameAccuracy=report.voiced?ratio(report.correctFrames,report.scoredFrames):0;
  report.noteAccuracy=report.voiced?ratio(report.noteCorrectFrames,report.scoredFrames):0;
  report.dropoutRate=report.voiced?ratio(report.dropoutFrames,report.scoredFrames):0;
  report.falsePositiveRate=report.voiced?0:ratio(report.falsePositiveFrames,report.scoredFrames);
  report.octaveErrorRate=report.voiced?ratio(report.octaveErrorFrames,report.scoredFrames):0;
  report.grossErrorRate=report.voiced?ratio(report.grossErrorFrames,report.scoredFrames):0;
  report.centsMae=mean(accumulator.absCents);
  report.centsMedian=median(accumulator.absCents);
  report.centsP95=percentile(accumulator.absCents,.95);
  report.finalNote=accumulator.lastFrame?.note??null;

  if(report.firstCorrectMs!==null)report.lockLatencyMs=report.firstCorrectMs-report.startMs;

  if(criteria){
    let pass=true;
    if(report.voiced){
      if(criteria.minVoicedFrameAccuracy!==undefined)pass&&=report.frameAccuracy>=criteria.minVoicedFrameAccuracy;
      if(criteria.minVoicedNoteAccuracy!==undefined)pass&&=report.noteAccuracy>=criteria.minVoicedNoteAccuracy;
      if(criteria.minVoicedDetectionRate!==undefined)pass&&=report.detectionRate>=criteria.minVoicedDetectionRate;
      if(criteria.maxDropoutRate!==undefined)pass&&=report.dropoutRate<=criteria.maxDropoutRate;
      if(criteria.maxVoicedCentsMae!==undefined)pass&&=report.centsMae!==null&&report.centsMae<=criteria.maxVoicedCentsMae;
      if(criteria.maxVoicedCentsP95!==undefined)pass&&=report.centsP95!==null&&report.centsP95<=criteria.maxVoicedCentsP95;
      if(criteria.maxOctaveErrorRate!==undefined)pass&&=report.octaveErrorRate<=criteria.maxOctaveErrorRate;
      if(criteria.maxGrossErrorRate!==undefined)pass&&=report.grossErrorRate<=criteria.maxGrossErrorRate;
    }else if(criteria.maxUnvoicedFalsePositiveRate!==undefined){
      pass&&=report.falsePositiveRate<=criteria.maxUnvoicedFalsePositiveRate;
    }
    report.pass=pass;
  }

  return report;
}

function aggregateReports(reports:TunerBenchmarkRecordingReport[]):TunerBenchmarkAggregate{
  const regionReports=reports.flatMap(recording=>recording.regions);
  const voiced=regionReports.filter(region=>region.voiced);
  const unvoiced=regionReports.filter(region=>!region.voiced);
  const cents=reports.flatMap(recording=>{
    const exact=recordingCents.get(recording);
    if(exact)return exact;
    return recording.regions.flatMap(region=>{
      if(!region.voiced||region.centsMae===null||!region.detectedFrames)return[];
      return Array.from({length:region.detectedFrames},()=>region.centsMae as number);
    });
  });
  const locks=voiced.map(region=>region.lockLatencyMs).filter((value):value is number=>value!==null);
  const lockSuccessRegions=locks.length;

  const voicedFrames=voiced.reduce((sum,region)=>sum+region.scoredFrames,0);
  const unvoicedFrames=unvoiced.reduce((sum,region)=>sum+region.scoredFrames,0);
  const detectedVoicedFrames=voiced.reduce((sum,region)=>sum+region.detectedFrames,0);
  const correctVoicedFrames=voiced.reduce((sum,region)=>sum+region.correctFrames,0);
  const noteCorrectVoicedFrames=voiced.reduce((sum,region)=>sum+region.noteCorrectFrames,0);
  const falsePositiveFrames=unvoiced.reduce((sum,region)=>sum+region.falsePositiveFrames,0);
  const octaveErrorFrames=voiced.reduce((sum,region)=>sum+region.octaveErrorFrames,0);

  return{
    recordings:reports.length,
    regions:regionReports.length,
    voicedRegions:voiced.length,
    unvoicedRegions:unvoiced.length,
    scoredFrames:voicedFrames+unvoicedFrames,
    voicedFrames,
    unvoicedFrames,
    detectedVoicedFrames,
    correctVoicedFrames,
    noteCorrectVoicedFrames,
    falsePositiveFrames,
    dropoutFrames:voiced.reduce((sum,region)=>sum+region.dropoutFrames,0),
    octaveErrorFrames,
    grossErrorFrames:voiced.reduce((sum,region)=>sum+region.grossErrorFrames,0),
    voicedDetectionRate:ratio(detectedVoicedFrames,voicedFrames),
    voicedFrameAccuracy:ratio(correctVoicedFrames,voicedFrames),
    voicedNoteAccuracy:ratio(noteCorrectVoicedFrames,voicedFrames),
    dropoutRate:ratio(voiced.reduce((sum,region)=>sum+region.dropoutFrames,0),voicedFrames),
    unvoicedFalsePositiveRate:ratio(falsePositiveFrames,unvoicedFrames),
    octaveErrorRate:ratio(octaveErrorFrames,voicedFrames),
    grossErrorRate:ratio(voiced.reduce((sum,region)=>sum+region.grossErrorFrames,0),voicedFrames),
    lockSuccessRate:ratio(lockSuccessRegions,voiced.length),
    centsMae:mean(cents),
    centsMedian:median(cents),
    centsP95:percentile(cents,.95),
    medianLockMs:median(locks)
  };
}

function criteriaPass(aggregate:TunerBenchmarkAggregate,criteria:TunerBenchmarkCriteria|undefined){
  if(!criteria)return null;
  let pass=true;
  if(criteria.minVoicedFrameAccuracy!==undefined)pass&&=aggregate.voicedFrameAccuracy>=criteria.minVoicedFrameAccuracy;
  if(criteria.minVoicedNoteAccuracy!==undefined)pass&&=aggregate.voicedNoteAccuracy>=criteria.minVoicedNoteAccuracy;
  if(criteria.minVoicedDetectionRate!==undefined)pass&&=aggregate.voicedDetectionRate>=criteria.minVoicedDetectionRate;
  if(criteria.maxDropoutRate!==undefined)pass&&=aggregate.dropoutRate<=criteria.maxDropoutRate;
  if(criteria.maxVoicedCentsMae!==undefined)pass&&=aggregate.centsMae!==null&&aggregate.centsMae<=criteria.maxVoicedCentsMae;
  if(criteria.maxVoicedCentsP95!==undefined)pass&&=aggregate.centsP95!==null&&aggregate.centsP95<=criteria.maxVoicedCentsP95;
  if(criteria.maxOctaveErrorRate!==undefined)pass&&=aggregate.octaveErrorRate<=criteria.maxOctaveErrorRate;
  if(criteria.maxGrossErrorRate!==undefined)pass&&=aggregate.grossErrorRate<=criteria.maxGrossErrorRate;
  if(criteria.maxUnvoicedFalsePositiveRate!==undefined)pass&&=aggregate.unvoicedFalsePositiveRate<=criteria.maxUnvoicedFalsePositiveRate;
  if(criteria.minLockSuccessRate!==undefined)pass&&=aggregate.lockSuccessRate>=criteria.minLockSuccessRate;
  if(criteria.maxMedianLockMs!==undefined)pass&&=aggregate.medianLockMs!==null&&aggregate.medianLockMs<=criteria.maxMedianLockMs;
  return pass;
}

export function benchmarkTunerRecording(
  manifest:TunerBenchmarkManifest,
  recording:TunerBenchmarkRecording,
  audio:TunerBenchmarkAudio
):TunerBenchmarkRecordingReport{
  if(!(audio.sampleRate>0))throw new Error(`Recording ${recording.id} has invalid sample rate`);
  if(audio.samples.length<2048)throw new Error(`Recording ${recording.id} is too short for tuner analysis`);

  const a4=recording.a4??manifest.defaults?.a4??DEFAULT_A4;
  const hopSize=Math.round(manifest.defaults?.hopSize??DEFAULT_HOP_SIZE);
  const engine=new FullTunerHarness(audio.sampleRate,a4);
  const accumulators=recording.regions.map((region,index)=>createRegionAccumulator(recording.id,region,index,a4));
  const durationMs=audio.samples.length/audio.sampleRate*1000;
  for(const region of recording.regions){
    if(region.endMs>durationMs+1){
      throw new Error(`Recording ${recording.id} region ending at ${region.endMs} ms exceeds audio duration ${durationMs.toFixed(2)} ms`);
    }
  }

  let regionIndex=0;
  for(let endSample=2048;endSample<=audio.samples.length;endSample+=hopSize){
    const now=endSample/audio.sampleRate*1000;
    while(regionIndex<recording.regions.length&&now>=recording.regions[regionIndex].endMs)regionIndex++;
    const region=recording.regions[regionIndex];
    const expectedHz=region&&now>=region.startMs&&now<region.endMs
      ?expectedFrequency(region,a4)
      :null;

    const frameStart=Math.max(0,endSample-8192);
    const frame=audio.samples.subarray(frameStart,endSample);
    const result=engine.process(frame,now,expectedHz);

    if(!region||now<region.startMs||now>=region.endMs)continue;
    const accumulator=accumulators[regionIndex];
    const report=accumulator.report;
    accumulator.lastFrame=result;
    report.totalFrames++;

    const expected=report.expectedHz;
    if(
      region.voiced &&
      expected!==null &&
      result.tracked.frequency &&
      report.firstCorrectMs===null
    ){
      const earlyError=pitchCentsError(result.tracked.frequency,expected);
      if(
        earlyError!==null &&
        Math.abs(earlyError)<=(report.toleranceCents as number)
      ){
        report.firstCorrectMs=now;
      }
    }

    const ignoreAttackMs=region.ignoreAttackMs??manifest.defaults?.ignoreAttackMs??DEFAULT_IGNORE_ATTACK_MS;
    if(now<region.startMs+ignoreAttackMs)continue;
    report.scoredFrames++;

    if(region.voiced){
      if(!result.tracked.frequency){
        report.dropoutFrames++;
        continue;
      }
      report.detectedFrames++;
      const voicedExpected=expected as number;
      const error=pitchCentsError(result.tracked.frequency,voicedExpected);
      if(error===null)continue;
      const absolute=Math.abs(error);
      accumulator.absCents.push(absolute);

      const detectedNote=noteFromFrequency(result.tracked.frequency,a4).label;
      if(detectedNote===report.expectedNote)report.noteCorrectFrames++;

      const tolerance=report.toleranceCents as number;
      if(absolute<=tolerance){
        report.correctFrames++;
      }else if(isPitchOctaveError(result.tracked.frequency,voicedExpected)){
        report.octaveErrorFrames++;
      }else if(absolute>100){
        report.grossErrorFrames++;
      }
    }else if(result.tracked.frequency){
      report.falsePositiveFrames++;
      report.detectedFrames++;
    }
  }

  const regions=accumulators.map((accumulator,index)=>
    finalizeRegion(accumulator,recording.regions[index],manifest.criteria)
  );
  const partial:TunerBenchmarkRecordingReport={
    id:recording.id,
    file:recording.file,
    sampleRate:audio.sampleRate,
    durationMs,
    channels:audio.channels,
    bitsPerSample:audio.bitsPerSample,
    tags:recording.tags??[],
    metadata:recording.metadata??{},
    regions,
    aggregate:{} as TunerBenchmarkAggregate,
    pass:null
  };
  recordingCents.set(partial,accumulators.flatMap(accumulator=>accumulator.absCents));
  partial.aggregate=aggregateReports([partial]);
  partial.pass=criteriaPass(partial.aggregate,manifest.criteria);
  return partial;
}

export function buildTunerBenchmarkReport(
  manifest:TunerBenchmarkManifest,
  recordings:TunerBenchmarkRecordingReport[]
):TunerBenchmarkReport{
  const aggregate=aggregateReports(recordings);
  const tags=new Set(recordings.flatMap(recording=>recording.tags));
  const byTag:Record<string,TunerBenchmarkAggregate>={};
  for(const tag of tags){
    byTag[tag]=aggregateReports(recordings.filter(recording=>recording.tags.includes(tag)));
  }
  return{
    version:1,
    criteria:manifest.criteria??null,
    recordings,
    aggregate,
    byTag,
    pass:criteriaPass(aggregate,manifest.criteria)
  };
}
