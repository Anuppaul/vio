export type TunerConsensusCandidate={
  frequency:number;
  clarity:number;
};

export type TunerConsensusResult={
  sequence:number;
  yin:TunerConsensusCandidate|null;
  mpm:TunerConsensusCandidate|null;
};

export type TunerConsensusRequest={
  sequence:number;
  sampleRate:number;
  minFrequency:number;
  maxFrequency:number;
  hintFrequency:number;
  long:Float32Array|null;
  short:Float32Array|null;
  fast:Float32Array;
};

export type TunerConsensusClient={
  submit:(request:TunerConsensusRequest)=>boolean;
  stop:()=>void;
};

export function createTunerConsensusClient(
  onResult:(result:TunerConsensusResult)=>void,
  onError:(message:string)=>void
):TunerConsensusClient|null{
  if(typeof Worker==='undefined')return null;

  let worker:Worker;
  try{
    worker=new Worker(new URL('./tuner-consensus.worker.ts',import.meta.url),{
      type:'module',
      name:'vio-tuner-consensus'
    });
  }catch{
    return null;
  }

  let stopped=false;
  let pending=false;
  let lastSubmitted=0;

  worker.onmessage=event=>{
    if(stopped)return;
    const data=event.data;
    pending=false;
    if(data?.type==='result'){
      onResult({
        sequence:Number(data.sequence)||0,
        yin:data.yin&&Number(data.yin.frequency)>0
          ?{frequency:Number(data.yin.frequency),clarity:Number(data.yin.clarity)||0}
          :null,
        mpm:data.mpm&&Number(data.mpm.frequency)>0
          ?{frequency:Number(data.mpm.frequency),clarity:Number(data.mpm.clarity)||0}
          :null
      });
      return;
    }
    if(data?.type==='error')onError(String(data.message||'Consensus DSP worker failed.'));
  };
  worker.onerror=()=>{
    pending=false;
    onError('Consensus DSP worker stopped unexpectedly.');
  };

  return{
    submit(request){
      if(stopped||pending||request.sequence<=lastSubmitted)return false;
      pending=true;
      lastSubmitted=request.sequence;
      const long=request.long?new Float32Array(request.long):null;
      const short=request.short?new Float32Array(request.short):null;
      const fast=new Float32Array(request.fast);
      const transfer:Transferable[]=[fast.buffer];
      if(short)transfer.push(short.buffer);
      if(long)transfer.push(long.buffer);
      try{
        worker.postMessage({
          type:'analyze',
          ...request,
          long,
          short,
          fast
        },transfer);
        return true;
      }catch{
        pending=false;
        return false;
      }
    },
    stop(){
      if(stopped)return;
      stopped=true;
      pending=false;
      worker.terminate();
    }
  };
}
