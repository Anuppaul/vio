export type PitchResult = { frequency: number; clarity: number; source: 'yin' | 'acf' | 'hybrid' | 'violin' } | null;

function clamp01(v:number){return Math.max(0,Math.min(1,v))}
function parabolic(values:Float32Array,index:number){
  if(index<=0||index>=values.length-1)return index;
  const y0=values[index-1],y1=values[index],y2=values[index+1],den=y0-2*y1+y2;
  if(Math.abs(den)<1e-12)return index;
  return index+Math.max(-1,Math.min(1,.5*(y0-y2)/den));
}
function centeredWindow(samples:Float32Array){
  const n=samples.length,out=new Float32Array(n);let mean=0;
  for(let i=0;i<n;i++)mean+=samples[i];mean/=n;
  for(let i=0;i<n;i++)out[i]=(samples[i]-mean)*(0.5-0.5*Math.cos(2*Math.PI*i/(n-1)));
  return out;
}
function normalizedCorrelation(x:Float32Array,lag:number){
  let dot=0,a2=0,b2=0;const limit=x.length-lag;
  for(let i=0;i<limit;i++){const a=x[i],b=x[i+lag];dot+=a*b;a2+=a*a;b2+=b*b}
  return a2>1e-12&&b2>1e-12?dot/Math.sqrt(a2*b2):0;
}

/**
 * Violin-first fundamental tracker. Searches only around the actual fundamental
 * periods of G3/D4/A4/E5 (±180 cents). Upper harmonics therefore cannot win just
 * because they have more spectral energy. The returned frequency is still the
 * measured frequency, so cents remain continuous (e.g. A4 at 444 Hz moves sharp).
 */
export function detectViolinPitch(samples:Float32Array,sampleRate:number,targets:readonly number[]):PitchResult{
  if(!samples.length||!sampleRate||!targets.length)return null;
  const x=centeredWindow(samples),corr=new Float32Array(Math.floor(samples.length/2));
  const ratio=Math.pow(2,180/1200);
  let bestLag=-1,bestScore=-1;
  for(const target of targets){
    const low=target/ratio,high=target*ratio;
    const from=Math.max(2,Math.floor(sampleRate/high));
    const to=Math.min(corr.length-2,Math.ceil(sampleRate/low));
    for(let lag=from;lag<=to;lag++){
      if(corr[lag]===0)corr[lag]=normalizedCorrelation(x,lag);
      const score=corr[lag];
      if(score>bestScore){bestScore=score;bestLag=lag}
    }
  }
  if(bestLag<0||bestScore<.22)return null;
  if(bestLag>0&&corr[bestLag-1]===0)corr[bestLag-1]=normalizedCorrelation(x,bestLag-1);
  if(bestLag+1<corr.length&&corr[bestLag+1]===0)corr[bestLag+1]=normalizedCorrelation(x,bestLag+1);
  const refined=parabolic(corr,bestLag),frequency=sampleRate/refined;
  if(!Number.isFinite(frequency))return null;
  return {frequency,clarity:clamp01(bestScore),source:'violin'};
}

export function detectYin(samples:Float32Array,sampleRate:number,minFreq=150,maxFreq=1800,threshold=.18):PitchResult{
  const n=samples.length;if(!n||!sampleRate)return null;
  const minTau=Math.max(2,Math.floor(sampleRate/maxFreq));
  const maxTau=Math.min(Math.floor(sampleRate/minFreq),Math.floor(n/2)-1);
  if(maxTau<=minTau)return null;
  const diff=new Float32Array(maxTau+1),cmnd=new Float32Array(maxTau+1);
  for(let tau=1;tau<=maxTau;tau++){
    let sum=0;for(let i=0,limit=n-tau;i<limit;i++){const d=samples[i]-samples[i+tau];sum+=d*d}diff[tau]=sum;
  }
  cmnd[0]=1;let running=0;
  for(let tau=1;tau<=maxTau;tau++){running+=diff[tau];cmnd[tau]=running>0?(diff[tau]*tau)/running:1}
  let tauEstimate=-1;
  for(let tau=minTau;tau<=maxTau;tau++)if(cmnd[tau]<threshold){while(tau+1<=maxTau&&cmnd[tau+1]<cmnd[tau])tau++;tauEstimate=tau;break}
  if(tauEstimate<0){let best=minTau;for(let tau=minTau+1;tau<=maxTau;tau++)if(cmnd[tau]<cmnd[best])best=tau;tauEstimate=best}
  const clarity=clamp01(1-cmnd[tauEstimate]);if(clarity<.08)return null;
  const refined=parabolic(cmnd,tauEstimate),frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFreq||frequency>maxFreq)return null;
  return {frequency,clarity,source:'yin'};
}

export function detectAutocorrelation(samples:Float32Array,sampleRate:number,minFreq=150,maxFreq=1800):PitchResult{
  const n=samples.length;if(!n||!sampleRate)return null;
  const x=centeredWindow(samples);
  const minLag=Math.max(2,Math.floor(sampleRate/maxFreq));
  const maxLag=Math.min(Math.floor(sampleRate/minFreq),Math.floor(n/2)-2);
  if(maxLag<=minLag)return null;
  const corr=new Float32Array(maxLag+1);
  for(let lag=minLag;lag<=maxLag;lag++)corr[lag]=normalizedCorrelation(x,lag);
  let best=-1,bestScore=-1;
  for(let lag=minLag+1;lag<maxLag;lag++){
    const score=corr[lag];
    if(score>corr[lag-1]&&score>=corr[lag+1]&&score>bestScore){best=lag;bestScore=score}
  }
  if(best<0||bestScore<.12)return null;
  const refined=parabolic(corr,best),frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFreq||frequency>maxFreq)return null;
  return {frequency,clarity:clamp01(bestScore),source:'acf'};
}

export function detectPitch(samples:Float32Array,sampleRate:number,minFreq=150,maxFreq=1800):PitchResult{
  const yin=detectYin(samples,sampleRate,minFreq,maxFreq),acf=detectAutocorrelation(samples,sampleRate,minFreq,maxFreq);
  if(!yin)return acf;if(!acf)return yin;
  const cents=Math.abs(1200*Math.log2(yin.frequency/acf.frequency));
  if(cents<=80){
    const wy=Math.max(.05,yin.clarity),wa=Math.max(.05,acf.clarity),frequency=(yin.frequency*wy+acf.frequency*wa)/(wy+wa);
    return {frequency,clarity:clamp01((yin.clarity+acf.clarity)/2+.08),source:'hybrid'};
  }
  // YIN is fundamental-first; do not let a louder upper-partial ACF peak replace it.
  if(yin.clarity>=.18)return yin;
  return acf;
}
