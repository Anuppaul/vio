const LONG_SIZE=8192;
const SHORT_SIZE=4096;
const FAST_SIZE=2048;
const HOP_SIZE=1024;

class VioTunerCaptureProcessor extends AudioWorkletProcessor{
  constructor(){
    super();
    this.ring=new Float32Array(LONG_SIZE);
    this.write=0;
    this.filled=0;
    this.sincePost=0;
    this.sequence=0;
    this.active=true;
    this.port.onmessage=event=>{
      if(event.data?.type==='stop')this.active=false;
      if(event.data?.type==='start')this.active=true;
    };
    this.port.postMessage({type:'ready',sampleRate});
  }

  latest(size){
    if(this.filled<size)return null;
    const output=new Float32Array(size);
    let start=this.write-size;
    if(start<0)start+=LONG_SIZE;
    const first=Math.min(size,LONG_SIZE-start);
    output.set(this.ring.subarray(start,start+first),0);
    if(first<size)output.set(this.ring.subarray(0,size-first),first);
    return output;
  }

  process(inputs,outputs){
    const output=outputs[0]?.[0];
    if(output)output.fill(0);
    if(!this.active)return true;

    const input=inputs[0]?.[0];
    if(!input?.length)return true;

    for(let i=0;i<input.length;i++){
      this.ring[this.write]=input[i];
      this.write=(this.write+1)%LONG_SIZE;
    }
    this.filled=Math.min(LONG_SIZE,this.filled+input.length);
    this.sincePost+=input.length;

    if(this.filled<FAST_SIZE||this.sincePost<HOP_SIZE)return true;
    this.sincePost%=HOP_SIZE;
    this.sequence++;

    const fast=this.latest(FAST_SIZE);
    const short=this.filled>=SHORT_SIZE?this.latest(SHORT_SIZE):null;
    const includeLong=this.filled>=LONG_SIZE&&(this.sequence%2===0);
    const long=includeLong?this.latest(LONG_SIZE):null;

    const payload={
      type:'frame',
      sequence:this.sequence,
      sampleRate,
      audioTime:currentTime,
      fast,
      short,
      long
    };
    const transfers=[];
    if(fast)transfers.push(fast.buffer);
    if(short)transfers.push(short.buffer);
    if(long)transfers.push(long.buffer);
    this.port.postMessage(payload,transfers);
    return true;
  }
}

registerProcessor('vio-tuner-capture',VioTunerCaptureProcessor);
