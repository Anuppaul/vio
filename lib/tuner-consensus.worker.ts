import { detectMpm } from './mpm';
import { detectPitch } from './yin';

type ConsensusRequest={
  type:'analyze';
  sequence:number;
  sampleRate:number;
  minFrequency:number;
  maxFrequency:number;
  hintFrequency:number;
  long:Float32Array|null;
  short:Float32Array|null;
  fast:Float32Array;
};

type Candidate={frequency:number;clarity:number}|null;

const scope=self as unknown as {
  onmessage:((event:MessageEvent<ConsensusRequest>)=>void)|null;
  postMessage:(value:unknown)=>void;
};

scope.onmessage=event=>{
  const request=event.data;
  if(request?.type!=='analyze')return;

  const {
    sequence,
    sampleRate,
    minFrequency,
    maxFrequency,
    hintFrequency,
    long,
    short,
    fast
  }=request;

  let yin:Candidate=null;
  let mpm:Candidate=null;

  try{
    const lowCandidate=hintFrequency>0&&hintFrequency<90;
    const yinInput=lowCandidate&&long?long:short;
    if(yinInput){
      const yinMin=lowCandidate?minFrequency:Math.max(55,minFrequency);
      const result=detectPitch(yinInput,sampleRate,yinMin,maxFrequency);
      if(result)yin={frequency:result.frequency,clarity:result.clarity};
    }

    if(hintFrequency>=70){
      const lowMpm=hintFrequency<220;
      const mpmInput=lowMpm&&short?short:fast;
      const mpmMin=lowMpm?Math.max(70,minFrequency):Math.max(180,minFrequency);
      const result=detectMpm(mpmInput,sampleRate,mpmMin,maxFrequency);
      if(result)mpm={frequency:result.frequency,clarity:result.clarity};
    }

    scope.postMessage({type:'result',sequence,yin,mpm});
  }catch{
    scope.postMessage({type:'error',sequence,message:'Consensus DSP worker failed.'});
  }
};
