export type PitchResult = { frequency: number; clarity: number; source: 'yin' | 'acf' | 'hybrid' } | null;

type Workspace={n:number;maxTau:number;prefix:Float64Array;diff:Float64Array;cmnd:Float64Array;corr:Float64Array};
let workspace:Workspace|null=null;

function clamp01(v:number){return Math.max(0,Math.min(1,v))}
function parabolic(values:ArrayLike<number>,index:number){
  if(index<=0||index>=values.length-1)return index;
  const y0=values[index-1],y1=values[index],y2=values[index+1],den=y0-2*y1+y2;
  if(Math.abs(den)<1e-12)return index;
  return index+Math.max(-1,Math.min(1,.5*(y0-y2)/den));
}
function getWorkspace(n:number,maxTau:number){
  if(!workspace||workspace.n!==n||workspace.maxTau<maxTau){
    workspace={n,maxTau,prefix:new Float64Array(n+1),diff:new Float64Array(maxTau+2),cmnd:new Float64Array(maxTau+2),corr:new Float64Array(maxTau+2)};
  }
  return workspace;
}
function localMin(values:ArrayLike<number>,center:number,radius:number,min:number,max:number){
  const lo=Math.max(min,Math.round(center-radius)),hi=Math.min(max,Math.round(center+radius));
  let best=-1,bestValue=Infinity;
  for(let i=lo;i<=hi;i++){
    if(i<=min||i>=max)continue;
    if(values[i]<=values[i-1]&&values[i]<values[i+1]&&values[i]<bestValue){best=i;bestValue=values[i]}
  }
  return best;
}

/**
 * Low-allocation YIN/NSDF hybrid tuned for a universal instrument tuner.
 * It deliberately uses a strict YIN valley before accepting a period, then
 * checks the adjacent octave in both directions. This rejects the common
 * case where a strong 2nd harmonic is mistaken for the fundamental, without
 * forcing any instrument-specific G/D/A/E bias.
 */
function detectCore(samples:Float32Array,sampleRate:number,minFreq:number,maxFreq:number,threshold=.085,source:'yin'|'acf'|'hybrid'='hybrid'):PitchResult{
  const n=samples.length;if(n<256||!Number.isFinite(sampleRate)||sampleRate<=0)return null;
  const minTau=Math.max(2,Math.floor(sampleRate/maxFreq));
  const maxTau=Math.min(Math.floor(sampleRate/minFreq),Math.floor(n/2)-2);
  if(maxTau<=minTau)return null;

  const w=getWorkspace(n,maxTau),{prefix,diff,cmnd,corr}=w;
  prefix[0]=0;
  for(let i=0;i<n;i++){const v=samples[i];prefix[i+1]=prefix[i]+v*v}
  diff[0]=0;corr[0]=1;

  for(let tau=1;tau<=maxTau;tau++){
    const limit=n-tau;let dot=0;
    for(let i=0;i<limit;i++)dot+=samples[i]*samples[i+tau];
    const e0=prefix[limit],e1=prefix[n]-prefix[tau],den=e0+e1;
    if(den<=1e-12){diff[tau]=den;corr[tau]=0;continue}
    corr[tau]=Math.max(-1,Math.min(1,2*dot/den));
    diff[tau]=Math.max(0,den-2*dot);
  }

  cmnd[0]=1;let running=0;
  for(let tau=1;tau<=maxTau;tau++){
    running+=diff[tau];
    cmnd[tau]=running>1e-12?diff[tau]*tau/running:1;
  }

  let primary=-1;
  for(let tau=minTau;tau<=maxTau;tau++){
    if(cmnd[tau]<threshold){
      while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau])tau++;
      primary=tau;break;
    }
  }

  if(primary<0){
    let global=-1,globalValue=Infinity;
    for(let tau=minTau+1;tau<maxTau;tau++){
      if(cmnd[tau]<=cmnd[tau-1]&&cmnd[tau]<cmnd[tau+1]&&cmnd[tau]<globalValue){global=tau;globalValue=cmnd[tau]}
    }
    if(global<0||globalValue>.38)return null;
    const cutoff=Math.min(.26,globalValue*1.35+.015);
    for(let tau=minTau+1;tau<maxTau;tau++){
      if(cmnd[tau]<=cmnd[tau-1]&&cmnd[tau]<cmnd[tau+1]&&cmnd[tau]<=cutoff&&corr[tau]>=.55){primary=tau;break}
    }
    if(primary<0)primary=global;
  }

  let period=primary;

  // Candidate is one octave too high: a true period near 2x must be
  // substantially cleaner, not merely another equally-good repeated cycle.
  if(period*2<=maxTau){
    const doubled=localMin(cmnd,period*2,Math.max(2,period*.10),minTau,maxTau);
    if(doubled>0&&cmnd[doubled]<cmnd[period]*.72&&corr[doubled]>corr[period]+.055)period=doubled;
  }

  // Candidate is one octave too low: prefer the primitive half-period only
  // when it is almost as periodic as the longer repeated cycle.
  const halved=localMin(cmnd,period/2,Math.max(2,period*.05),minTau,maxTau);
  if(halved>0&&cmnd[halved]<=cmnd[period]*1.35+.004&&cmnd[halved]<=.14&&corr[halved]>=corr[period]-.055)period=halved;

  const refined=parabolic(cmnd,period),frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFreq||frequency>maxFreq)return null;
  const yinQuality=1-cmnd[period],periodicity=Math.max(0,corr[period]);
  const clarity=clamp01(.62*yinQuality+.38*periodicity);
  if(clarity<.28)return null;
  return {frequency,clarity,source};
}

export function detectYin(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85,threshold=.085):PitchResult{
  return detectCore(samples,sampleRate,minFreq,maxFreq,threshold,'yin');
}

export function detectAutocorrelation(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  return detectCore(samples,sampleRate,minFreq,maxFreq,.085,'acf');
}

export function detectPitch(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  return detectCore(samples,sampleRate,minFreq,maxFreq,.085,'hybrid');
}
