export type PitchResult = { frequency: number; clarity: number; source: 'yin' | 'acf' | 'hybrid' } | null;

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

export function detectYin(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85,threshold=.18):PitchResult{
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

export function detectAutocorrelation(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
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

export function detectPitch(samples:Float32Array,sampleRate:number,minFreq=31.77,maxFreq=3227.85):PitchResult{
  const yin=detectYin(samples,sampleRate,minFreq,maxFreq),acf=detectAutocorrelation(samples,sampleRate,minFreq,maxFreq);
  if(!yin)return acf;if(!acf)return yin;
  const cents=Math.abs(1200*Math.log2(yin.frequency/acf.frequency));
  if(cents<=80){
    const wy=Math.max(.05,yin.clarity),wa=Math.max(.05,acf.clarity),frequency=(yin.frequency*wy+acf.frequency*wa)/(wy+wa);
    return {frequency,clarity:clamp01((yin.clarity+acf.clarity)/2+.08),source:'hybrid'};
  }
  // Generic fundamental-first choice: prefer YIN when it has a credible period.
  if(yin.clarity>=.18)return yin;
  return acf;
}
