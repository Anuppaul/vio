const workspaces=new Map();
let lowDecimated=new Float32Array(0);

function clamp01(v){return Math.max(0,Math.min(1,v))}
function centsBetween(a,b){return Math.abs(1200*Math.log2(a/b))}
function parabolic(values,index){
  if(index<=0||index>=values.length-1)return index;
  const y0=values[index-1],y1=values[index],y2=values[index+1];
  const den=y0-2*y1+y2;
  if(Math.abs(den)<1e-12)return index;
  return index+Math.max(-1,Math.min(1,.5*(y0-y2)/den));
}
function workspace(n,maxTau){
  let w=workspaces.get(n);
  if(!w||w.maxTau<maxTau){
    w={
      maxTau,
      prefix:new Float64Array(n+1),
      diff:new Float64Array(maxTau+2),
      cmnd:new Float64Array(maxTau+2),
      corr:new Float64Array(maxTau+2)
    };
    workspaces.set(n,w);
  }
  return w;
}
function localMin(values,center,radius,min,max){
  const lo=Math.max(min,Math.round(center-radius));
  const hi=Math.min(max,Math.round(center+radius));
  let best=-1,bestValue=Infinity;
  for(let i=lo;i<=hi;i++){
    if(i<=min||i>=max)continue;
    if(values[i]<=values[i-1]&&values[i]<values[i+1]&&values[i]<bestValue){
      best=i;bestValue=values[i];
    }
  }
  return best;
}
function primitivePeriod(cmnd,corr,period,minTau,maxTau){
  let best=period;
  for(let divisor=12;divisor>=2;divisor--){
    const center=period/divisor;
    if(center<=minTau+1)continue;
    const candidate=localMin(cmnd,center,Math.max(2,center*.08),minTau,maxTau);
    if(candidate<0)continue;
    const comparable=cmnd[candidate]<=cmnd[period]*1.55+.008&&corr[candidate]>=corr[period]-.045;
    const stronglyPeriodic=cmnd[candidate]<=.11&&corr[candidate]>=.87;
    if(comparable&&stronglyPeriodic){best=candidate;break}
  }
  return best;
}
function detectCore(samples,sampleRate,minFreq,maxFreq,threshold=.12){
  const n=samples.length;
  if(n<256||!Number.isFinite(sampleRate)||sampleRate<=0||maxFreq<=minFreq)return null;
  const minTau=Math.max(2,Math.floor(sampleRate/maxFreq));
  const maxTau=Math.min(Math.floor(sampleRate/minFreq),Math.floor(n/2)-2);
  if(maxTau<=minTau)return null;

  const w=workspace(n,maxTau),{prefix,diff,cmnd,corr}=w;
  prefix[0]=0;
  for(let i=0;i<n;i++){const v=samples[i];prefix[i+1]=prefix[i]+v*v}
  diff[0]=0;corr[0]=1;

  for(let tau=1;tau<=maxTau;tau++){
    const limit=n-tau;
    let dot=0;
    for(let i=0;i<limit;i++)dot+=samples[i]*samples[i+tau];
    const e0=prefix[limit],e1=prefix[n]-prefix[tau],den=e0+e1;
    if(den<=1e-12){diff[tau]=den;corr[tau]=0;continue}
    corr[tau]=Math.max(-1,Math.min(1,2*dot/den));
    diff[tau]=Math.max(0,den-2*dot);
  }

  cmnd[0]=1;
  let running=0;
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
      if(cmnd[tau]<=cmnd[tau-1]&&cmnd[tau]<cmnd[tau+1]&&cmnd[tau]<globalValue){
        global=tau;globalValue=cmnd[tau];
      }
    }
    if(global<0||globalValue>.42)return null;
    const cutoff=Math.min(.30,globalValue*1.45+.02);
    for(let tau=minTau+1;tau<maxTau;tau++){
      if(cmnd[tau]<=cmnd[tau-1]&&cmnd[tau]<cmnd[tau+1]&&cmnd[tau]<=cutoff&&corr[tau]>=.48){
        primary=tau;break;
      }
    }
    if(primary<0)primary=global;
  }

  const period=primitivePeriod(cmnd,corr,primary,minTau,maxTau);
  const refined=parabolic(cmnd,period);
  const frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFreq||frequency>maxFreq)return null;
  const clarity=clamp01(.60*(1-cmnd[period])+.40*Math.max(0,corr[period]));
  return clarity>=.22?{frequency,clarity}:null;
}
function tail(samples,size){return samples.subarray(Math.max(0,samples.length-size))}
function downsample2(samples){
  const length=Math.floor(samples.length/2);
  if(lowDecimated.length!==length)lowDecimated=new Float32Array(length);
  for(let i=0,j=0;i<length;i++,j+=2)lowDecimated[i]=(samples[j]+samples[j+1])*.5;
  return lowDecimated;
}
function clusterCenter(items){
  let weightedLog=0,total=0;
  for(const c of items){
    const weight=c.weight*(.40+.60*c.clarity);
    weightedLog+=Math.log(c.frequency)*weight;
    total+=weight;
  }
  return total>0?Math.exp(weightedLog/total):items[0]?.frequency||0;
}
function clusterScore(items){
  let score=0;
  for(const c of items)score+=c.weight*(.40+.60*c.clarity);
  if(items.length>1)score+=Math.min(.35,(items.length-1)*.10);
  return score;
}
function hasResolution(items,...names){return items.some(c=>names.includes(c.band))}
function harmonicRatio(a,b){
  const hi=Math.max(a,b),lo=Math.min(a,b),ratio=hi/lo,nearest=Math.round(ratio);
  return nearest>=2&&nearest<=12&&Math.abs(1200*Math.log2(ratio/nearest))<=42?nearest:0;
}
function fuseCandidates(candidates){
  if(!candidates.length)return null;
  candidates.sort((a,b)=>a.frequency-b.frequency);
  const clusters=[];
  for(const candidate of candidates){
    let best=null,bestDistance=Infinity;
    for(const cluster of clusters){
      const distance=centsBetween(candidate.frequency,clusterCenter(cluster));
      if(distance<=55&&distance<bestDistance){best=cluster;bestDistance=distance}
    }
    if(best)best.push(candidate);else clusters.push([candidate]);
  }
  clusters.sort((a,b)=>clusterScore(b)-clusterScore(a));
  let winner=clusters[0];

  for(const other of clusters.slice(1)){
    const wf=clusterCenter(winner),of=clusterCenter(other),ratio=harmonicRatio(wf,of);
    if(!ratio)continue;
    const low=wf<of?winner:other,high=wf<of?other:winner;
    const lowLong=hasResolution(low,'long','full'),highLong=hasResolution(high,'long','full');
    const lowScore=clusterScore(low),highScore=clusterScore(high);
    if(lowLong&&low.length>=2&&(!highLong||lowScore>=highScore*.78)){winner=low;continue}
    if(low.length===1&&!lowLong&&high.length>=2){winner=high;continue}
    if(low.length===1&&highLong&&high.length>=2&&highScore>lowScore*1.15)winner=high;
  }

  const frequency=clusterCenter(winner);
  let qualityWeight=0,qualityTotal=0;
  for(const c of winner){qualityTotal+=c.clarity*c.weight;qualityWeight+=c.weight}
  const base=qualityWeight?qualityTotal/qualityWeight:0;
  return{frequency,clarity:clamp01(base+Math.min(.20,Math.max(0,winner.length-1)*.06))};
}
function detectPitch(samples,sampleRate,minFreq,maxFreq){
  if(samples.length<1024)return null;
  const candidates=[];
  const add=(band,frame,rate,min,weight,threshold)=>{
    const effectiveMin=Math.max(minFreq,min);
    if(maxFreq<=effectiveMin)return;
    const result=detectCore(frame,rate,effectiveMin,maxFreq,threshold);
    if(result)candidates.push({...result,weight,band});
  };
  add('long',downsample2(samples),sampleRate/2,minFreq,1.45,.105);
  add('full',tail(samples,4096),sampleRate,minFreq,1.25,.11);
  add('short',tail(samples,2048),sampleRate,60,.90,.125);
  add('fast',tail(samples,1024),sampleRate,180,.65,.15);
  return fuseCandidates(candidates);
}

function detectMpm(samples,sampleRate,minFrequency=55,maxFrequency=2000){
  const size=samples.length;
  if(size<512||maxFrequency<=minFrequency)return null;
  const minTau=Math.max(2,Math.floor(sampleRate/maxFrequency));
  const maxTau=Math.min(Math.floor(sampleRate/minFrequency),Math.floor(size/2)-2);
  if(maxTau<=minTau)return null;

  let mean=0;
  for(let i=0;i<size;i++)mean+=samples[i];
  mean/=size;
  const centered=new Float32Array(size);
  const prefix=new Float64Array(size+1);
  for(let i=0;i<size;i++){
    const value=samples[i]-mean;
    centered[i]=value;
    prefix[i+1]=prefix[i]+value*value;
  }
  const nsdf=new Float64Array(maxTau+2);
  nsdf[0]=1;
  let strongest=0;
  const peaks=[];
  for(let tau=1;tau<=maxTau;tau++){
    const limit=size-tau;
    let correlation=0;
    for(let i=0;i<limit;i++)correlation+=centered[i]*centered[i+tau];
    const denominator=prefix[limit]+(prefix[size]-prefix[tau]);
    nsdf[tau]=denominator>1e-12?Math.max(-1,Math.min(1,2*correlation/denominator)):0;
  }
  for(let tau=minTau+1;tau<maxTau;tau++){
    const value=nsdf[tau];
    if(value>0&&value>=nsdf[tau-1]&&value>nsdf[tau+1]){
      peaks.push(tau);strongest=Math.max(strongest,value);
    }
  }
  if(!peaks.length||strongest<.55)return null;
  const cutoff=Math.max(.55,strongest*.90);
  let selected=peaks.find(peak=>nsdf[peak]>=cutoff);
  if(selected===undefined)return null;
  const refined=parabolic(nsdf,selected);
  const frequency=sampleRate/refined;
  if(!Number.isFinite(frequency)||frequency<minFrequency||frequency>maxFrequency)return null;
  return{frequency,clarity:clamp01(nsdf[selected])};
}

self.onmessage=event=>{
  const request=event.data;
  if(request?.type!=='analyze')return;
  const {sequence,sampleRate,minFrequency,maxFrequency,hintFrequency,long,short,fast}=request;
  try{
    let yin=null,mpm=null;
    const lowCandidate=hintFrequency>0&&hintFrequency<90;
    const yinInput=lowCandidate&&long?long:short;
    if(yinInput){
      const result=detectPitch(yinInput,sampleRate,lowCandidate?minFrequency:Math.max(55,minFrequency),maxFrequency);
      if(result)yin=result;
    }
    if(hintFrequency>=70){
      const lowMpm=hintFrequency<220;
      const mpmInput=lowMpm&&short?short:fast;
      const result=detectMpm(
        mpmInput,
        sampleRate,
        lowMpm?Math.max(70,minFrequency):Math.max(180,minFrequency),
        maxFrequency
      );
      if(result)mpm=result;
    }
    self.postMessage({type:'result',sequence,yin,mpm});
  }catch{
    self.postMessage({type:'error',sequence,message:'Consensus DSP worker failed.'});
  }
};
