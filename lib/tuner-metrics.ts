export function pitchCentsError(actual:number,expected:number){
  if(!(actual>0)||!(expected>0))return null;
  return 1200*Math.log2(actual/expected);
}

export function isPitchOctaveError(
  actual:number,
  expected:number,
  toleranceCents=55
){
  const raw=pitchCentsError(actual,expected);
  if(raw===null)return false;
  const octaves=Math.round(raw/1200);
  if(octaves===0)return false;
  return Math.abs(raw-octaves*1200)<=toleranceCents;
}

export function percentile(values:number[],fraction:number){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  const p=Math.max(0,Math.min(1,fraction));
  const position=(sorted.length-1)*p;
  const lower=Math.floor(position);
  const upper=Math.ceil(position);
  if(lower===upper)return sorted[lower];
  const weight=position-lower;
  return sorted[lower]*(1-weight)+sorted[upper]*weight;
}

export function median(values:number[]){
  return percentile(values,.5);
}

export function mean(values:number[]){
  if(!values.length)return null;
  return values.reduce((sum,value)=>sum+value,0)/values.length;
}

export function ratio(numerator:number,denominator:number){
  return denominator>0?numerator/denominator:0;
}
