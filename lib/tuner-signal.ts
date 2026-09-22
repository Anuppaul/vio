export function segmentRms(
  buffer:Float32Array,
  start:number,
  end:number
){
  let sum=0;
  let count=0;
  for(let i=Math.max(0,start);i<Math.min(buffer.length,end);i++){
    sum+=buffer[i]*buffer[i];
    count++;
  }
  return count?Math.sqrt(sum/count):0;
}

export function prepareSensitiveFrame(
  input:Float32Array,
  output:Float32Array,
  {
    targetRms=.32,
    maxGain=64,
    maxPeak=.97
  }:{
    targetRms?:number;
    maxGain?:number;
    maxPeak?:number;
  }={}
){
  let mean=0;
  for(let i=0;i<input.length;i++)mean+=input[i];
  mean/=input.length;

  let sum=0;
  let peak=0;
  for(let i=0;i<input.length;i++){
    const value=input[i]-mean;
    sum+=value*value;
    peak=Math.max(peak,Math.abs(value));
  }

  const frameRms=Math.sqrt(sum/input.length);
  const rmsGain=frameRms>0?targetRms/frameRms:1;
  const peakGain=peak>0?maxPeak/peak:1;
  const gain=Math.max(1,Math.min(maxGain,rmsGain,peakGain));

  for(let i=0;i<input.length;i++)output[i]=(input[i]-mean)*gain;
  return {frameRms,gain};
}
