const LONG_SIZE=8192;
const SHORT_SIZE=4096;
const FAST_SIZE=2048;
const HOP_SIZE=1024;
const TARGET_RMS=.32;
const MAX_GAIN=64;
const MAX_PEAK=.97;

class VioTunerCaptureProcessor extends AudioWorkletProcessor{
  constructor(){
    super();
    this.ring=new Float32Array(LONG_SIZE);
    this.write=0;
    this.filled=0;
    this.sincePost=0;
    this.sequence=0;
    this.active=true;
    this.awaitingAck=false;
    this.fastPool=[];
    this.shortPool=[];
    this.longPool=[];
    this.port.onmessage=event=>{
      const data=event.data;
      if(data?.type==='stop')this.active=false;
      if(data?.type==='start')this.active=true;
      if(data?.type==='ack'){
        this.awaitingAck=false;
        this.recycle(data.fastBuffer,this.fastPool,FAST_SIZE);
        this.recycle(data.shortBuffer,this.shortPool,SHORT_SIZE);
        this.recycle(data.longBuffer,this.longPool,LONG_SIZE);
      }
    };
    this.port.postMessage({type:'ready',sampleRate});
  }

  recycle(buffer,pool,size){
    if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==size*4||pool.length>=2)return;
    pool.push(new Float32Array(buffer));
  }

  take(pool,size){
    return pool.pop()||new Float32Array(size);
  }

  latest(size,pool){
    if(this.filled<size)return null;
    const output=this.take(pool,size);
    let start=this.write-size;
    if(start<0)start+=LONG_SIZE;
    const first=Math.min(size,LONG_SIZE-start);
    output.set(this.ring.subarray(start,start+first),0);
    if(first<size)output.set(this.ring.subarray(0,size-first),first);
    return output;
  }

  segmentRms(frame,start,end){
    let sum=0;
    let count=0;
    const safeStart=Math.max(0,start);
    const safeEnd=Math.min(frame.length,end);
    for(let i=safeStart;i<safeEnd;i++){
      const value=frame[i];
      sum+=value*value;
      count++;
    }
    return count?Math.sqrt(sum/count):0;
  }

  prepare(frame){
    let mean=0;
    for(let i=0;i<frame.length;i++)mean+=frame[i];
    mean/=frame.length;

    let sum=0;
    let peak=0;
    for(let i=0;i<frame.length;i++){
      const value=frame[i]-mean;
      frame[i]=value;
      sum+=value*value;
      peak=Math.max(peak,Math.abs(value));
    }

    const frameRms=Math.sqrt(sum/frame.length);
    const rmsGain=frameRms>0?TARGET_RMS/frameRms:1;
    const peakGain=peak>0?MAX_PEAK/peak:1;
    const gain=Math.max(1,Math.min(MAX_GAIN,rmsGain,peakGain));
    if(gain>1){
      for(let i=0;i<frame.length;i++)frame[i]*=gain;
    }
    return frame;
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
    if(this.awaitingAck)return true;
    this.awaitingAck=true;
    this.sequence++;

    const fastRaw=this.latest(FAST_SIZE,this.fastPool);
    const shortRaw=this.filled>=SHORT_SIZE?this.latest(SHORT_SIZE,this.shortPool):null;
    const includeLong=this.filled>=LONG_SIZE&&(this.sequence%2===0);
    const longRaw=includeLong?this.latest(LONG_SIZE,this.longPool):null;
    if(!fastRaw)return true;

    const rms=this.segmentRms(fastRaw,0,FAST_SIZE);
    const recentRms=this.segmentRms(fastRaw,FAST_SIZE-512,FAST_SIZE);
    const previousRms=this.segmentRms(fastRaw,0,FAST_SIZE-512);
    const onset=recentRms>Math.max(previousRms*1.18,previousRms+.00018);

    const fast=this.prepare(fastRaw);
    const short=shortRaw?this.prepare(shortRaw):null;
    const long=longRaw?this.prepare(longRaw):null;

    const payload={
      type:'frame',
      sequence:this.sequence,
      sampleRate,
      audioTime:currentTime,
      rms,
      onset,
      fast,
      short,
      long
    };
    const transfers=[fast.buffer];
    if(short)transfers.push(short.buffer);
    if(long)transfers.push(long.buffer);
    this.port.postMessage(payload,transfers);
    return true;
  }
}

registerProcessor('vio-tuner-capture',VioTunerCaptureProcessor);
