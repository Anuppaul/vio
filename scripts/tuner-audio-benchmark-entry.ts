import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  csv:string|null;
  only:Set<string>|null;
};

function usage(){
  console.log('Usage: node scripts/run-tuner-audio-benchmark.mjs --manifest <file> [--json] [--out <report.json>] [--csv <regions.csv>] [--only id1,id2]');
}

function parseArgs(argv:string[]):CliOptions{
  let manifest='';
  let json=false;
  let out:string|null=null;
  let csv:string|null=null;
  let only:Set<string>|null=null;

  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--manifest'){
      manifest=argv[++i]??'';
    }else if(arg==='--json'){
      json=true;
    }else if(arg==='--out'){
      out=argv[++i]??null;
    }else if(arg==='--csv'){
      csv=argv[++i]??null;
    }else if(arg==='--only'){
      const value=argv[++i]??'';
      only=new Set(value.split(',').map(item=>item.trim()).filter(Boolean));
    }else if(arg==='--help'||arg==='-h'){
      usage();
      process.exitCode=0;
      return{manifest:'',json,out,csv,only};
    }else{
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if(!manifest)throw new Error('--manifest is required');
  return{manifest,json,out,csv,only};
}

function sha256(value:Uint8Array|string){
  return createHash('sha256').update(value).digest('hex');
}

function currentCommit(){
  const result=spawnSync('git',['rev-parse','HEAD'],{
    cwd:process.cwd(),
    encoding:'utf8'
  });
  return result.status===0?result.stdout.trim()||null:null;
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
  console.log(`  voiced fine accuracy: ${percent(aggregate.voicedFrameAccuracy)}`);
  console.log(`  voiced note accuracy: ${percent(aggregate.voicedNoteAccuracy)}`);
  console.log(`  voiced detection rate: ${percent(aggregate.voicedDetectionRate)}`);
  console.log(`  dropout rate: ${percent(aggregate.dropoutRate)}`);
  console.log(`  false-positive rate: ${percent(aggregate.unvoicedFalsePositiveRate)}`);
  console.log(`  octave-error rate: ${percent(aggregate.octaveErrorRate)}`);
  console.log(`  gross-error rate: ${percent(aggregate.grossErrorRate)}`);
  console.log(`  lock success rate: ${percent(aggregate.lockSuccessRate)}`);
  console.log(`  cents MAE / median / p95: ${numberOrDash(aggregate.centsMae)} / ${numberOrDash(aggregate.centsMedian)} / ${numberOrDash(aggregate.centsP95)}`);
  console.log(`  median lock: ${aggregate.medianLockMs===null?'—':aggregate.medianLockMs.toFixed(1)+' ms'}`);
}

function csvCell(value:unknown){
  if(value===null||value===undefined)return '';
  const text=String(value);
  return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

function benchmarkCsv(recordings:TunerBenchmarkRecordingReport[]){
  const header=[
    'recording_id','file','tags','region_id','label','voiced','start_ms','end_ms',
    'expected_note','expected_hz','tolerance_cents','scored_frames','detection_rate',
    'fine_accuracy','note_accuracy','dropout_rate','false_positive_rate',
    'octave_error_rate','gross_error_rate','cents_mae','cents_median','cents_p95',
    'lock_latency_ms','pass'
  ];
  const rows=[header.map(csvCell).join(',')];

  for(const recording of recordings){
    for(const region of recording.regions){
      rows.push([
        recording.id,
        recording.file,
        recording.tags.join('|'),
        region.id,
        region.label,
        region.voiced,
        region.startMs,
        region.endMs,
        region.expectedNote,
        region.expectedHz,
        region.toleranceCents,
        region.scoredFrames,
        region.detectionRate,
        region.frameAccuracy,
        region.noteAccuracy,
        region.dropoutRate,
        region.falsePositiveRate,
        region.octaveErrorRate,
        region.grossErrorRate,
        region.centsMae,
        region.centsMedian,
        region.centsP95,
        region.lockLatencyMs,
        region.pass
      ].map(csvCell).join(','));
    }
  }

  return rows.join('\n')+'\n';
}

function printRecording(recording:TunerBenchmarkRecordingReport){
  console.log('');
  console.log(`${recording.pass===null?'INFO':recording.pass?'PASS':'FAIL'} Recording ${recording.id}`);
  console.log(`  file: ${recording.file}`);
  if(recording.sha256)console.log(`  WAV SHA256: ${recording.sha256}`);
  console.log(`  audio: ${recording.sampleRate} Hz, ${(recording.durationMs/1000).toFixed(2)} s${recording.channels?`, ${recording.channels} ch`:''}${recording.bitsPerSample?`, ${recording.bitsPerSample}-bit`:''}`);
  if(recording.tags.length)console.log(`  tags: ${recording.tags.join(', ')}`);
  printAggregate('  aggregate:',recording.aggregate);

  for(const region of recording.regions){
    const mark=region.pass===null?'INFO':region.pass?'PASS':'FAIL';
    if(region.voiced){
      console.log(
        `  ${mark} region ${region.id} [${region.startMs.toFixed(0)}–${region.endMs.toFixed(0)} ms] expected=${region.expectedNote} ${region.expectedHz?.toFixed(2)} Hz | fine=${percent(region.frameAccuracy)} note=${percent(region.noteAccuracy)} detect=${percent(region.detectionRate)} dropout=${percent(region.dropoutRate)} centsMAE=${numberOrDash(region.centsMae)} p95=${numberOrDash(region.centsP95)} lock=${region.lockLatencyMs===null?'—':region.lockLatencyMs.toFixed(1)+' ms'} octave=${region.octaveErrorFrames} gross=${region.grossErrorFrames} (${percent(region.grossErrorRate)})`
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
  const manifestText=await readFile(manifestPath,'utf8');
  const manifest=normalizeTunerBenchmarkManifest(
    JSON.parse(manifestText)
  );

  const selected=options.only
    ?manifest.recordings.filter(recording=>options.only?.has(recording.id))
    :manifest.recordings;

  if(options.only){
    const known=new Set(manifest.recordings.map(recording=>recording.id));
    const unknown=[...options.only].filter(id=>!known.has(id));
    if(unknown.length)throw new Error(`Unknown --only recording id(s): ${unknown.join(', ')}`);
  }
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
        bitsPerSample:decoded.bitsPerSample,
        sha256:sha256(bytes)
      })
    );
  }

  const report=buildTunerBenchmarkReport(
    {...manifest,recordings:selected},
    reports,
    {
      engineCommit:currentCommit(),
      manifestSha256:sha256(manifestText),
      manifestPath
    }
  );

  if(options.out){
    const outPath=resolve(options.out);
    await mkdir(dirname(outPath),{recursive:true});
    await writeFile(outPath,JSON.stringify(report,null,2)+'\n','utf8');
  }

  if(options.csv){
    const csvPath=resolve(options.csv);
    await mkdir(dirname(csvPath),{recursive:true});
    await writeFile(csvPath,benchmarkCsv(report.recordings),'utf8');
  }

  if(options.json){
    console.log(JSON.stringify(report,null,2));
  }else{
    console.log('');
    console.log('VIO Real-Audio Sound Tuner Benchmark');
    console.log('====================================');
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Engine commit: ${report.provenance?.engineCommit??'unknown'}`);
    console.log(`Manifest SHA256: ${report.provenance?.manifestSha256??'unknown'}`);
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
