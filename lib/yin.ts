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
function tail(samples:Float32Array,size:number){
  return samples.subarray(Math.max(0,samples.length-size));
}
function downsample2(samples:Float32Array){
  const length=Math.floor(samples.length/2);
  if(lowDecimated.length!==length)lowDecimated=new Float32Array(length);
  for(let i=0,j=0;i<length;i++,j+=2)lowDecimated[i]=(samples[j]+samples[j+1])*.5;
  return lowDecimated;
}

/**
 * Low-allocation YIN/NSDF period estimator. minFreq/maxFreq are intentionally
 * supplied per analysis band by detectPitch(), so the same primitive can work
 * from C1 through G7 without teaching it any instrument/string-specific notes.
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

  let period=primary;

  // Resolve the common one-octave ambiguity inside each band. Cross-band
  // consensus below handles larger harmonic mistakes without biasing low/high.
  if(period*2<=maxTau){
    const doubled=localMin(cmnd,period*2,Math.max(2,period*.10),minTau,maxTau);
    if(doubled>0&&cmnd[doubled]<cmnd[period]*.74&&corr[doubled]>corr[period]+.045)period=doubled;
  }
  const halved=localMin(cmnd,period/2,Math.max(2,period*.05),minTau,maxTau);
  if(halved>0&&cmnd[halved]<=cmnd[period]*1.38+.006&&cmnd[halved]<=.16&&corr[halved]>=corr[period]-.065)period=halved;

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
  return score;
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
  const winner=clusters[0],frequency=clusterCenter(winner.items);
  let qualityWeight=0,qualityTotal=0;
  for(const c of winner.items){const w=c.weight;qualityTotal+=c.clarity*w;qualityWeight+=w}
  const baseQuality=qualityWeight?qualityTotal/qualityWeight:0;
  const supportBonus=Math.min(.18,Math.max(0,winner.items.length-1)*.07);
  const clarity=clamp01(baseQuality+supportBonus);
  return {frequency,clarity,source:'multi'};
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
 * A single analysis window cannot be equally optimal for a ~33 Hz bass note
 * and a >3 kHz violin/flute/piano note. We therefore analyse overlapping
 * low/mid/high bands at different time resolutions and choose the frequency
 * supported by the strongest cross-band consensus.
 *
 * - Low: downsampled long window for C1/E1/bass fundamentals.
 * - Mid: medium window for guitar/voice/piano middle register.
 * - High: short window for upper strings/keys/winds.
 * - Upper/top: extra short constrained windows that prevent a high note from
 *   collapsing to a 1/2, 1/3 or 1/4 subharmonic.
 */
export function detectPitch(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  if(samples.length<1024||!Number.isFinite(sampleRate)||sampleRate<=0)return null;
  const candidates:Candidate[]=[];
  const add=(band:string,frame:Float32Array,rate:number,min:number,max:number,weight:number,threshold:number)=>{
    if(max<=min)return;
    const result=detectCore(frame,rate,min,max,threshold,'hybrid');
    if(result)candidates.push({frequency:result.frequency,clarity:result.clarity,weight,band});
  };

  const low=downsample2(samples);
  add('low',low,sampleRate/2,minFreq,Math.min(maxFreq,350),1.15,.12);
  add('mid',tail(samples,4096),sampleRate,Math.max(minFreq,70),Math.min(maxFreq,900),1.10,.12);
  add('high',tail(samples,2048),sampleRate,Math.max(minFreq,250),Math.min(maxFreq,1800),1.05,.13);
  add('upper',tail(samples,1536),sampleRate,Math.max(minFreq,800),maxFreq,1.00,.15);
  add('top',tail(samples,1024),sampleRate,Math.max(minFreq,1600),maxFreq,1.00,.18);

  return fuseCandidates(candidates);
}
