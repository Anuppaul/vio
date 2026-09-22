import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import {
  benchmarkTunerRecording,
  buildTunerBenchmarkReport,
  normalizeTunerBenchmarkManifest,
  type TunerBenchmarkAggregate,
  type TunerBenchmarkRecordingReport
} from '../lib/tuner-audio-benchmark';
import { decodeWav } from '../lib/wav';

type CliOptions={
  manifest:string;
  json:boolean;
  out:string|null;
  only:Set<string>|null;
};

function usage(){
  console.log('Usage: node scripts/run-tuner-audio-benchmark.mjs --manifest <file> [--json] [--out <report.json>] [--only id1,id2]');
}

function parseArgs(argv:string[]):CliOptions{
  let manifest='';
  let json=false;
  let out:string|null=null;
  let only:Set<string>|null=null;

  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--manifest'){
      manifest=argv[++i]??'';
    }else if(arg==='--json'){
      json=true;
    }else if(arg==='--out'){
      out=argv[++i]??null;
    }else if(arg==='--only'){
      const value=argv[++i]??'';
      only=new Set(value.split(',').map(item=>item.trim()).filter(Boolean));
    }else if(arg==='--help'||arg==='-h'){
      usage();
      process.exitCode=0;
      return{manifest:'',json,out,only};
    }else{
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if(!manifest)throw new Error('--manifest is required');
  return{manifest,json,out,only};
}

function percent(value:number){
  return `${(value*100).toFixed(2)}%`;
}

function numberOrDash(value:number|null,digits=2){
  return value===null?'—':value.toFixed(digits);
}

function printAggregate(label:string,aggregate:TunerBenchmarkAggregate){
  console.log(label);
  console.log(`  recordings: ${aggregate.recordings}, regions: ${aggregate.regions} (${aggregate.voicedRegions} voiced / ${aggregate.unvoicedRegions} unvoiced)`);
  console.log(`  voiced frame accuracy: ${percent(aggregate.voicedFrameAccuracy)}`);
  console.log(`  voiced detection rate: ${percent(aggregate.voicedDetectionRate)}`);
  console.log(`  false-positive rate: ${percent(aggregate.unvoicedFalsePositiveRate)}`);
  console.log(`  octave-error rate: ${percent(aggregate.octaveErrorRate)}`);
  console.log(`  gross-error rate: ${percent(aggregate.grossErrorRate)}`);
  console.log(`  lock success rate: ${percent(aggregate.lockSuccessRate)}`);
  console.log(`  cents MAE / median / p95: ${numberOrDash(aggregate.centsMae)} / ${numberOrDash(aggregate.centsMedian)} / ${numberOrDash(aggregate.centsP95)}`);
  console.log(`  median lock: ${aggregate.medianLockMs===null?'—':aggregate.medianLockMs.toFixed(1)+' ms'}`);
}

function printRecording(recording:TunerBenchmarkRecordingReport){
  console.log('');
  console.log(`${recording.pass===null?'INFO':recording.pass?'PASS':'FAIL'} Recording ${recording.id}`);
  console.log(`  file: ${recording.file}`);
  console.log(`  audio: ${recording.sampleRate} Hz, ${(recording.durationMs/1000).toFixed(2)} s${recording.channels?`, ${recording.channels} ch`:''}${recording.bitsPerSample?`, ${recording.bitsPerSample}-bit`:''}`);
  if(recording.tags.length)console.log(`  tags: ${recording.tags.join(', ')}`);
  printAggregate('  aggregate:',recording.aggregate);

  for(const region of recording.regions){
    const mark=region.pass===null?'INFO':region.pass?'PASS':'FAIL';
    if(region.voiced){
      console.log(
        `  ${mark} region ${region.id} [${region.startMs.toFixed(0)}–${region.endMs.toFixed(0)} ms] expected=${region.expectedNote} ${region.expectedHz?.toFixed(2)} Hz | accuracy=${percent(region.frameAccuracy)} detect=${percent(region.detectionRate)} centsMAE=${numberOrDash(region.centsMae)} p95=${numberOrDash(region.centsP95)} lock=${region.lockLatencyMs===null?'—':region.lockLatencyMs.toFixed(1)+' ms'} octave=${region.octaveErrorFrames} gross=${region.grossErrorFrames}`
      );
    }else{
      console.log(
        `  ${mark} region ${region.id} [${region.startMs.toFixed(0)}–${region.endMs.toFixed(0)} ms] unvoiced | falsePos=${region.falsePositiveFrames}/${region.scoredFrames} (${percent(region.falsePositiveRate)})`
      );
    }
  }
}

const options=parseArgs(process.argv.slice(2));
if(!options.manifest){
  // --help path
}else{
  const manifestPath=resolve(options.manifest);
  const manifestDir=dirname(manifestPath);
  const manifest=normalizeTunerBenchmarkManifest(
    JSON.parse(await readFile(manifestPath,'utf8'))
  );

  const selected=options.only
    ?manifest.recordings.filter(recording=>options.only?.has(recording.id))
    :manifest.recordings;

  if(!selected.length)throw new Error('No recordings selected by --only');

  const reports:TunerBenchmarkRecordingReport[]=[];
  for(const recording of selected){
    const filePath=isAbsolute(recording.file)
      ?recording.file
      :resolve(manifestDir,recording.file);
    const bytes=await readFile(filePath);
    const decoded=decodeWav(bytes);
    reports.push(
      benchmarkTunerRecording(manifest,recording,{
        sampleRate:decoded.sampleRate,
        samples:decoded.samples,
        channels:decoded.channels,
        bitsPerSample:decoded.bitsPerSample
      })
    );
  }

  const report=buildTunerBenchmarkReport(
    {...manifest,recordings:selected},
    reports
  );

  if(options.out){
    const outPath=resolve(options.out);
    await writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
  }

  if(options.json){
    console.log(JSON.stringify(report,null,2));
  }else{
    console.log('');
    console.log('VIO Real-Audio Sound Tuner Benchmark');
    console.log('====================================');
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Criteria: ${report.criteria?'enabled':'report-only'}`);
    printAggregate('Overall:',report.aggregate);
    for(const recording of report.recordings)printRecording(recording);

    if(Object.keys(report.byTag).length){
      console.log('');
      console.log('By tag');
      for(const [tag,aggregate] of Object.entries(report.byTag)){
        printAggregate(`  ${tag}:`,aggregate);
      }
    }

    console.log('');
    console.log(`Overall result: ${report.pass===null?'REPORT ONLY':report.pass?'PASS':'FAIL'}`);
  }

  if(report.pass===false)process.exitCode=1;
}
