export type PitchSource = 'yin' | 'acf' | 'hybrid' | 'multi';
export type PitchResult = { frequency: number; clarity: number; source: PitchSource } | null;

type Workspace={n:number;maxTau:number;prefix:Float64Array;diff:Float64Array;cmnd:Float64Array;corr:Float64Array};
type Candidate={frequency:number;clarity:number;weight:number;band:string};
type Cluster={items:Candidate[]};

const workspaces=new Map<number,Workspace>();
let lowDecimated=new Float32Array(0);

function clamp01(v:number){return Math.max(0,Math.min(1,v))}
function centsBetween(a:number,b:number){return Math.abs(1200*Math.log2(a/b))}
function parabolic(values:ArrayLike<number>,index:number){
  if(index<=0||index>=values.length-1)return index;
  const y0=values[index-1],y1=values[index],y2=values[index+1],den=y0-2*y1+y2;
  if(Math.abs(den)<1e-12)return index;
  return index+Math.max(-1,Math.min(1,.5*(y0-y2)/den));
}
function getWorkspace(n:number,maxTau:number){
  let w=workspaces.get(n);
  if(!w||w.maxTau<maxTau){
    w={n,maxTau,prefix:new Float64Array(n+1),diff:new Float64Array(maxTau+2),cmnd:new Float64Array(maxTau+2),corr:new Float64Array(maxTau+2)};
    workspaces.set(n,w);
  }
  return w;
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
function tail(samples:Float32Array,size:number){return samples.subarray(Math.max(0,samples.length-size))}
function downsample2(samples:Float32Array){
  const length=Math.floor(samples.length/2);
  if(lowDecimated.length!==length)lowDecimated=new Float32Array(length);
  for(let i=0,j=0;i<length;i++,j+=2)lowDecimated[i]=(samples[j]+samples[j+1])*.5;
  return lowDecimated;
}

/**
 * Reduce an accidentally selected repeated period to its primitive period.
 * A high note repeats perfectly after 2x, 3x ... N times its true period, so
 * a broad detector can otherwise report an artificial low subharmonic. We
 * only divide when the shorter period is itself an almost-equally clean
 * periodic match. This is instrument-agnostic and preserves genuine bass
 * fundamentals whose full waveform does not repeat at the shorter divisor.
 */
function primitivePeriod(cmnd:ArrayLike<number>,corr:ArrayLike<number>,period:number,minTau:number,maxTau:number){
  let best=period;
  for(let divisor=12;divisor>=2;divisor--){
    const center=period/divisor;if(center<=minTau+1)continue;
    const candidate=localMin(cmnd,center,Math.max(2,center*.08),minTau,maxTau);if(candidate<0)continue;
    const comparable=cmnd[candidate]<=cmnd[period]*1.55+.008&&corr[candidate]>=corr[period]-.045;
    const stronglyPeriodic=cmnd[candidate]<=.11&&corr[candidate]>=.87;
    if(comparable&&stronglyPeriodic){best=candidate;break}
  }
  return best;
}

/**
 * Low-allocation YIN/NSDF period estimator. The search itself is always given
 * the widest physically useful pitch range by detectPitch(). Different time
 * resolutions are used for low/mid/high responsiveness instead of artificial
 * upper band ceilings, which avoids creating fake 1/N subharmonics.
 */
function detectCore(samples:Float32Array,sampleRate:number,minFreq:number,maxFreq:number,threshold=.12,source:PitchSource='hybrid'):PitchResult{
  const n=samples.length;if(n<256||!Number.isFinite(sampleRate)||sampleRate<=0||maxFreq<=minFreq)return null;
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
    if(global<0||globalValue>.42)return null;
    const cutoff=Math.min(.30,globalValue*1.45+.02);
    for(let tau=minTau+1;tau<maxTau;tau++){
      if(cmnd[tau]<=cmnd[tau-1]&&cmnd[tau]<cmnd[tau+1]&&cmnd[tau]<=cutoff&&corr[tau]>=.48){primary=tau;break}
    }
    if(primary<0)primary=global;
  }

  let period=primitivePeriod(cmnd,corr,primary,minTau,maxTau);

  // If a dominant harmonic was selected too high, allow a longer true period
  // only when the longer waveform repeat is materially cleaner.
  let bestLong=period;
  for(let multiple=2;multiple<=4;multiple++){
    if(period*multiple>maxTau)break;
    const candidate=localMin(cmnd,period*multiple,Math.max(2,period*.10),minTau,maxTau);if(candidate<0)continue;
    if(cmnd[candidate]<cmnd[bestLong]*.72&&corr[candidate]>corr[bestLong]+.045)bestLong=candidate;
  }
  period=bestLong;

  const refined=parabolic(cmnd,period),frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFreq||frequency>maxFreq)return null;
  const yinQuality=1-cmnd[period],periodicity=Math.max(0,corr[period]);
  const clarity=clamp01(.60*yinQuality+.40*periodicity);
  if(clarity<.22)return null;
  return {frequency,clarity,source};
}

function clusterCenter(items:Candidate[]){
  let weightedLog=0,total=0;
  for(const c of items){const w=c.weight*(.40+.60*c.clarity);weightedLog+=Math.log(c.frequency)*w;total+=w}
  return total>0?Math.exp(weightedLog/total):items[0]?.frequency??0;
}
function clusterScore(items:Candidate[]){
  let score=0;
  for(const c of items)score+=c.weight*(.40+.60*c.clarity);
  if(items.length>1)score+=Math.min(.35,(items.length-1)*.10);
  return score;
}
function hasResolution(items:Candidate[],...names:string[]){return items.some(c=>names.includes(c.band))}
function harmonicRatio(a:number,b:number){
  const hi=Math.max(a,b),lo=Math.min(a,b),ratio=hi/lo,nearest=Math.round(ratio);
  return nearest>=2&&nearest<=12&&Math.abs(1200*Math.log2(ratio/nearest))<=42?nearest:0;
}
function fuseCandidates(candidates:Candidate[]):PitchResult{
  if(!candidates.length)return null;
  candidates.sort((a,b)=>a.frequency-b.frequency);
  const clusters:Cluster[]=[];

  for(const candidate of candidates){
    let best:Cluster|null=null,bestDistance=Infinity;
    for(const cluster of clusters){
      const distance=centsBetween(candidate.frequency,clusterCenter(cluster.items));
      if(distance<=55&&distance<bestDistance){best=cluster;bestDistance=distance}
    }
    if(best)best.items.push(candidate);else clusters.push({items:[candidate]});
  }

  clusters.sort((a,b)=>clusterScore(b.items)-clusterScore(a.items));
  let winner=clusters[0];

  // Resolution-aware harmonic arbitration. A low fundamental supported by the
  // long/full windows beats short-window harmonics. Conversely, a lone low
  // subharmonic cannot beat a higher pitch independently confirmed by two
  // faster windows. This is based on temporal evidence, never instrument type.
  for(const other of clusters.slice(1)){
    const wf=clusterCenter(winner.items),of=clusterCenter(other.items),ratio=harmonicRatio(wf,of);if(!ratio)continue;
    const low=wf<of?winner:other,high=wf<of?other:winner;
    const lowLong=hasResolution(low.items,'long','full'),highLong=hasResolution(high.items,'long','full');
    const lowScore=clusterScore(low.items),highScore=clusterScore(high.items);
    if(lowLong&&low.items.length>=2&&(!highLong||lowScore>=highScore*.78)){winner=low;continue}
    if(low.items.length===1&&!lowLong&&high.items.length>=2){winner=high;continue}
    if(low.items.length===1&&highLong&&high.items.length>=2&&highScore>lowScore*1.15){winner=high}
  }

  const frequency=clusterCenter(winner.items);let qualityWeight=0,qualityTotal=0;
  for(const c of winner.items){qualityTotal+=c.clarity*c.weight;qualityWeight+=c.weight}
  const baseQuality=qualityWeight?qualityTotal/qualityWeight:0;
  const supportBonus=Math.min(.20,Math.max(0,winner.items.length-1)*.06);
  return {frequency,clarity:clamp01(baseQuality+supportBonus),source:'multi'};
}

export function detectYin(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85,threshold=.10):PitchResult{
  return detectCore(samples,sampleRate,minFreq,maxFreq,threshold,'yin');
}
export function detectAutocorrelation(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  return detectCore(samples,sampleRate,minFreq,maxFreq,.12,'acf');
}

/**
 * Full-range universal detector.
 *
 * Every resolution is allowed to see the real upper pitch. Long windows give
 * bass notes enough cycles; short windows make high notes fast and stable.
 * Critically, no low-resolution pass is capped at e.g. 350 Hz, so a D4 cannot
 * be forced into a fake C1/C2-style subharmonic merely because D4 is outside
 * that pass's search range.
 */
export function detectPitch(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  if(samples.length<1024||!Number.isFinite(sampleRate)||sampleRate<=0)return null;
  const candidates:Candidate[]=[];
  const add=(band:string,frame:Float32Array,rate:number,min:number,weight:number,threshold:number)=>{
    const effectiveMin=Math.max(minFreq,min);if(maxFreq<=effectiveMin)return;
    const result=detectCore(frame,rate,effectiveMin,maxFreq,threshold,'hybrid');
    if(result)candidates.push({frequency:result.frequency,clarity:result.clarity,weight,band});
  };

  // Long downsampled view: ~5+ cycles even around C1 at 48 kHz input.
  add('long',downsample2(samples),sampleRate/2,minFreq,1.45,.105);
  // Full-rate medium view: accurate cents throughout the normal instrument range.
  add('full',tail(samples,4096),sampleRate,minFreq,1.25,.11);
  // Faster views cannot physically resolve the very lowest fundamentals, so
  // their minimum is raised; their maximum is never lowered.
  add('short',tail(samples,2048),sampleRate,60,.90,.125);
  add('fast',tail(samples,1024),sampleRate,180,.65,.15);

  return fuseCandidates(candidates);
}
