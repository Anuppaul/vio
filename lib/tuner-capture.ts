export type TunerCaptureFrame={
  sequence:number;
  sampleRate:number;
  audioTime:number;
  fast:Float32Array;
  short:Float32Array|null;
  long:Float32Array|null;
};

export type TunerWorkletCapture={
  node:AudioWorkletNode;
  sink:GainNode;
  stop:()=>void;
};

const loadedContexts=new WeakSet<AudioContext>();

function toFloat32(value:unknown){
  return value instanceof Float32Array?value:null;
}

export function supportsTunerAudioWorklet(ctx:AudioContext){
  return (
    typeof AudioWorkletNode!=='undefined' &&
    !!ctx.audioWorklet &&
    typeof ctx.audioWorklet.addModule==='function'
  );
}

export async function createTunerWorkletCapture(
  ctx:AudioContext,
  source:MediaStreamAudioSourceNode,
  onFrame:(frame:TunerCaptureFrame)=>void,
  onError:(message:string)=>void
):Promise<TunerWorkletCapture|null>{
  if(!supportsTunerAudioWorklet(ctx))return null;

  let node:AudioWorkletNode|null=null;
  let sink:GainNode|null=null;
  let handleMessage:((event:MessageEvent)=>void)|null=null;
  let handleProcessorError:(()=>void)|null=null;

  const cleanup=()=>{
    if(node&&handleMessage)node.port.removeEventListener('message',handleMessage);
    if(node&&handleProcessorError)node.removeEventListener('processorerror',handleProcessorError);
    try{if(node)source.disconnect(node)}catch{}
    try{node?.disconnect()}catch{}
    try{sink?.disconnect()}catch{}
  };

  try{
    if(!loadedContexts.has(ctx)){
      await ctx.audioWorklet.addModule('/tuner-capture-worklet.js?v=1');
      loadedContexts.add(ctx);
    }

    node=new AudioWorkletNode(ctx,'vio-tuner-capture',{
      numberOfInputs:1,
      numberOfOutputs:1,
      outputChannelCount:[1],
      channelCount:1,
      channelCountMode:'explicit'
    });
    sink=ctx.createGain();
    sink.gain.value=0;

    handleMessage=(event:MessageEvent)=>{
      const data=event.data;
      if(data?.type!=='frame')return;
      const fast=toFloat32(data.fast);
      if(!fast)return;
      try{
        onFrame({
          sequence:Number(data.sequence)||0,
          sampleRate:Number(data.sampleRate)||ctx.sampleRate,
          audioTime:Number(data.audioTime)||0,
          fast,
          short:toFloat32(data.short),
          long:toFloat32(data.long)
        });
      }catch{
        onError('AudioWorklet frame processing failed.');
      }
    };
    handleProcessorError=()=>onError('AudioWorklet capture processor stopped unexpectedly.');

    node.port.addEventListener('message',handleMessage);
    node.port.start();
    node.addEventListener('processorerror',handleProcessorError);
    source.connect(node);
    node.connect(sink).connect(ctx.destination);

    const activeNode=node;
    const activeSink=sink;
    let stopped=false;
    return{
      node:activeNode,
      sink:activeSink,
      stop(){
        if(stopped)return;
        stopped=true;
        try{activeNode.port.postMessage({type:'stop'})}catch{}
        cleanup();
      }
    };
  }catch{
    cleanup();
    return null;
  }
}
