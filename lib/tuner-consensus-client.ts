export type TunerConsensusCandidate={
  frequency:number;
  clarity:number;
};

export type TunerConsensusResult={
  sequence:number;
  hintFrequency:number;
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
    worker=new Worker('/tuner-consensus-worker.js?v=2',{
      name:'vio-tuner-consensus'
    });
  }catch{
    return null;
  }

  let stopped=false;
  let pending=false;
  let lastSubmitted=0;
  let timeoutId:number|null=null;

  const clearPendingTimeout=()=>{
    if(timeoutId!==null){
      self.clearTimeout(timeoutId);
      timeoutId=null;
    }
  };

  worker.onmessage=event=>{
    if(stopped)return;
    const data=event.data;
    pending=false;
    clearPendingTimeout();
    if(data?.type==='result'){
      onResult({
        sequence:Number(data.sequence)||0,
        hintFrequency:Number(data.hintFrequency)||0,
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
    clearPendingTimeout();
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
        clearPendingTimeout();
        timeoutId=self.setTimeout(()=>{
          if(stopped||!pending)return;
          pending=false;
          timeoutId=null;
          onError('Consensus DSP worker timed out.');
        },350);
        return true;
      }catch{
        pending=false;
        clearPendingTimeout();
        return false;
      }
    },
    stop(){
      if(stopped)return;
      stopped=true;
      pending=false;
      clearPendingTimeout();
      worker.terminate();
    }
  };
}
