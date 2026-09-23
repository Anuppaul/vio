import { spawnSync } from 'node:child_process';
import { writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FFMPEG=process.env.VIO_FFMPEG||'ffmpeg';
const FFPROBE=process.env.VIO_FFPROBE||'ffprobe';
const KEYS=['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const FILES=['sa-pa','sa-ma'].flatMap(pattern=>KEYS.map(key=>`${pattern}_${key}.mp3`));
const ROOT='out/assets/tanpura';
const TARGET_SECONDS=10;

function command(command,args,{capture=false,maxBuffer=96*1024*1024}={}){
  const result=spawnSync(command,args,{
    encoding:capture?'utf8':undefined,
    stdio:capture?['ignore','pipe','pipe']:'inherit',
    maxBuffer
  });
  if(result.error)throw new Error(`${command} unavailable: ${result.error.message}`);
  if(result.status!==0){
    const stderr=capture&&typeof result.stderr==='string'?result.stderr.trim():'';
    throw new Error(`${command} failed${stderr?`: ${stderr}`:''}`);
  }
  return result;
}

function probe(path){
  const result=command(FFPROBE,[
    '-v','error',
    '-select_streams','a:0',
    '-show_entries','stream=sample_rate,channels:format=duration',
    '-of','json',
    path
  ],{capture:true});
  const parsed=JSON.parse(result.stdout);
  const stream=parsed.streams?.[0];
  const sampleRate=Number(stream?.sample_rate);
  const channels=Number(stream?.channels);
  const duration=Number(parsed.format?.duration);
  if(!(sampleRate>0)||!(channels>0)||!(duration>0)){
    throw new Error(`Could not probe audio metadata for ${path}`);
  }
  return {sampleRate,channels,duration};
}

function decodeFloat(path){
  const result=spawnSync(FFMPEG,[
    '-v','error','-i',path,
    '-map','0:a:0',
    '-f','f32le',
    '-acodec','pcm_f32le',
    'pipe:1'
  ],{
    stdio:['ignore','pipe','pipe'],
    maxBuffer:96*1024*1024
  });
  if(result.error)throw new Error(`${FFMPEG} unavailable: ${result.error.message}`);
  if(result.status!==0){
    throw new Error(`Failed decoding ${path}: ${String(result.stderr||'').trim()}`);
  }
  const bytes=result.stdout;
  if(!Buffer.isBuffer(bytes)||bytes.length<4)throw new Error(`Decoded audio is empty: ${path}`);
  const raw=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  return new Float32Array(raw);
}

function sampleAt(samples,channels,frame,channel){
  const index=frame*channels+channel;
  return index>=0&&index<samples.length?samples[index]:0;
}

function zeroCrossNear(samples,channels,frameCount,index,radius){
  const center=Math.max(1,Math.min(frameCount-2,Math.round(index)));
  const lo=Math.max(1,center-radius),hi=Math.min(frameCount-2,center+radius);
  let best=center,bestAmp=Math.abs(sampleAt(samples,channels,center,0));
  for(let i=lo;i<=hi;i++){
    const a=sampleAt(samples,channels,i,0);
    const b=sampleAt(samples,channels,i+1,0);
    const crossing=a===0||a*b<=0;
    if(!crossing)continue;
    const amp=Math.abs(a);
    if(amp<bestAmp){best=i;bestAmp=amp}
  }
  return best;
}

function activeBounds(samples,sampleRate,channels){
  const frameCount=Math.floor(samples.length/channels);
  let peak=0;
  for(let i=0;i<samples.length;i++)peak=Math.max(peak,Math.abs(samples[i]));
  if(peak<=1e-6)return {start:0,end:frameCount/sampleRate};

  const threshold=Math.max(peak*.008,.00035);
  const window=Math.max(32,Math.floor(sampleRate*.006));
  const active=(from,to)=>{
    let sum=0,count=0;
    const safeTo=Math.min(frameCount,to);
    for(let frame=from;frame<safeTo;frame++){
      for(let ch=0;ch<channels;ch++){
        const value=sampleAt(samples,channels,frame,ch);
        sum+=value*value;
        count++;
      }
    }
    return count?Math.sqrt(sum/count):0;
  };

  let first=0,last=frameCount;
  for(let i=0;i<frameCount-window;i+=window){
    if(active(i,i+window)>=threshold){first=i;break}
  }
  for(let i=frameCount-window;i>first;i-=window){
    if(active(i,i+window)>=threshold){last=Math.min(frameCount,i+window);break}
  }

  const lead=Math.floor(sampleRate*.012),tail=Math.floor(sampleRate*.012);
  first=Math.max(0,first-lead);
  last=Math.min(frameCount,last+tail);
  const radius=Math.floor(sampleRate*.006);
  first=zeroCrossNear(samples,channels,frameCount,first,radius);
  last=zeroCrossNear(samples,channels,frameCount,Math.max(first+2,last-1),radius)+1;
  if(last-first<sampleRate*.5)return {start:0,end:frameCount/sampleRate};
  return {start:first/sampleRate,end:last/sampleRate};
}

function seamCost(samples,sampleRate,channels,start,end){
  const frameCount=Math.floor(samples.length/channels);
  const window=Math.max(64,Math.floor(sampleRate*.10));
  const points=96,step=Math.max(1,Math.floor(window/points));
  let total=0;
  for(let ch=0;ch<channels;ch++){
    let dot=0,a2=0,b2=0;
    for(let i=0;i<points;i++){
      const offset=i*step;
      const a=sampleAt(samples,channels,Math.min(frameCount-1,start+offset),ch);
      const b=sampleAt(samples,channels,Math.min(frameCount-1,end+offset),ch);
      dot+=a*b;a2+=a*a;b2+=b*b;
    }
    const corr=(a2>1e-12&&b2>1e-12)?dot/Math.sqrt(a2*b2):0;
    const rmsA=Math.sqrt(a2/points),rmsB=Math.sqrt(b2/points);
    const rmsCost=Math.abs(Math.log((rmsA+1e-8)/(rmsB+1e-8)));
    const edgeCost=Math.min(
      1,
      Math.abs(
        sampleAt(samples,channels,start,ch)-
        sampleAt(samples,channels,end,ch)
      )/.05
    );
    const slopeA=
      sampleAt(samples,channels,Math.min(frameCount-1,start+1),ch)-
      sampleAt(samples,channels,start,ch);
    const slopeB=
      sampleAt(samples,channels,Math.min(frameCount-1,end+1),ch)-
      sampleAt(samples,channels,end,ch);
    const slopeCost=Math.min(1,Math.abs(slopeA-slopeB)/.02);
    total+=(1-Math.max(-1,Math.min(1,corr)))*.68+rmsCost*.18+edgeCost*.08+slopeCost*.06;
  }
  return total/Math.max(1,channels);
}

function compactBounds(samples,sampleRate,channels){
  const active=activeBounds(samples,sampleRate,channels);
  const duration=active.end-active.start;
  if(duration<=14)return active;

  const frameCount=Math.floor(samples.length/channels);
  const safeStart=active.start+2;
  const safeEnd=active.end-2;
  const baseStart=Math.min(
    safeEnd-TARGET_SECONDS-1,
    Math.max(safeStart,active.start+Math.min(15,duration*.25))
  );
  const zeroRadius=Math.max(24,Math.floor(sampleRate*.004));
  let best={start:baseStart,end:baseStart+TARGET_SECONDS,cost:Number.POSITIVE_INFINITY};

  for(let startOffset=-1;startOffset<=1.0001;startOffset+=.25){
    const startIndex=zeroCrossNear(
      samples,channels,frameCount,(baseStart+startOffset)*sampleRate,zeroRadius
    );
    const start=startIndex/sampleRate;
    if(start<safeStart||start>safeEnd-9)continue;

    for(let candidateDuration=9;candidateDuration<=11.0001;candidateDuration+=.025){
      const endIndex=zeroCrossNear(
        samples,channels,frameCount,(start+candidateDuration)*sampleRate,zeroRadius
      );
      const end=endIndex/sampleRate;
      if(end>safeEnd||end-start<8.8)continue;
      const cost=
        seamCost(samples,sampleRate,channels,startIndex,endIndex)+
        Math.abs((end-start)-TARGET_SECONDS)*.035;
      if(cost<best.cost)best={start,end,cost};
    }
  }

  if(!Number.isFinite(best.cost))return active;
  return best;
}

async function compactFile(file){
  const path=join(ROOT,file);
  const before=await stat(path);
  const metadata=probe(path);

  if(metadata.duration<=14){
    return {
      file,
      sourceBytes:before.size,
      compactBytes:before.size,
      start:0,
      end:metadata.duration,
      duration:metadata.duration,
      reused:true
    };
  }

  const samples=decodeFloat(path);
  const bounds=compactBounds(samples,metadata.sampleRate,metadata.channels);
  const selectedDuration=bounds.end-bounds.start;
  if(selectedDuration<8.8||selectedDuration>11.2){
    throw new Error(`Unsafe compact duration for ${file}: ${selectedDuration.toFixed(3)}s`);
  }

  const temp=join(dirname(path),`.${file}.compact.tmp.mp3`);
  await rm(temp,{force:true});
  command(FFMPEG,[
    '-v','error','-y',
    '-i',path,
    '-map','0:a:0',
    '-af',`atrim=start=${bounds.start.toFixed(6)}:end=${bounds.end.toFixed(6)},asetpts=PTS-STARTPTS`,
    '-c:a','libmp3lame',
    '-b:a','192k',
    '-ar','48000',
    '-map_metadata','-1',
    '-write_xing','1',
    temp
  ]);

  const compactMeta=probe(temp);
  if(compactMeta.duration<8.5||compactMeta.duration>11.5){
    await rm(temp,{force:true});
    throw new Error(`Encoded compact duration invalid for ${file}: ${compactMeta.duration.toFixed(3)}s`);
  }

  await rename(temp,path);
  const after=await stat(path);
  return {
    file,
    sourceBytes:before.size,
    compactBytes:after.size,
    start:Number(bounds.start.toFixed(6)),
    end:Number(bounds.end.toFixed(6)),
    duration:Number(compactMeta.duration.toFixed(6)),
    reused:false
  };
}

command(FFMPEG,['-version'],{capture:true,maxBuffer:2*1024*1024});
command(FFPROBE,['-version'],{capture:true,maxBuffer:2*1024*1024});

const results=[];
for(const file of FILES){
  const result=await compactFile(file);
  results.push(result);
  const saved=result.sourceBytes-result.compactBytes;
  console.log(
    `Tanpura compact: ${file} · ${result.duration.toFixed(2)}s · ${(result.compactBytes/1024).toFixed(0)} KiB · saved ${(saved/1024).toFixed(0)} KiB`
  );
}

const sourceBytes=results.reduce((sum,item)=>sum+item.sourceBytes,0);
const compactBytes=results.reduce((sum,item)=>sum+item.compactBytes,0);
const manifest={
  generatedAt:new Date().toISOString(),
  codec:'MP3 192 kbps / 48 kHz',
  targetSeconds:TARGET_SECONDS,
  files:results,
  totals:{
    sourceBytes,
    compactBytes,
    savedBytes:sourceBytes-compactBytes,
    reductionPercent:Number(((1-compactBytes/sourceBytes)*100).toFixed(2))
  }
};
await writeFile(join(ROOT,'android-compact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(
  `Tanpura Android payload: ${(sourceBytes/1024/1024).toFixed(2)} MiB → ${(compactBytes/1024/1024).toFixed(2)} MiB (${manifest.totals.reductionPercent}% smaller)`
);
