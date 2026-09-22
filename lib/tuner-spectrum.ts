function isPowerOfTwo(value:number){
  return value>0&&(value&(value-1))===0;
}

function reverseBits(value:number,bits:number){
  let reversed=0;
  for(let i=0;i<bits;i++){
    reversed=(reversed<<1)|(value&1);
    value>>>=1;
  }
  return reversed;
}

/**
 * Deterministic Hann-windowed radix-2 FFT used by tuner regression fixtures.
 * It intentionally returns WebAudio-style dB magnitudes so the real
 * harmonic-profile/fusion code can be exercised without an AudioContext.
 */
export function spectrumDbFromSamples(samples:Float32Array){
  const size=samples.length;
  if(!isPowerOfTwo(size)||size<2)throw new Error('Spectrum size must be a power of two');

  const real=new Float64Array(size);
  const imag=new Float64Array(size);
  const bits=Math.log2(size);

  for(let i=0;i<size;i++){
    const window=size>1?.5-.5*Math.cos(2*Math.PI*i/(size-1)):1;
    real[reverseBits(i,bits)]=samples[i]*window;
  }

  for(let width=2;width<=size;width<<=1){
    const half=width>>1;
    const step=-2*Math.PI/width;
    for(let start=0;start<size;start+=width){
      for(let offset=0;offset<half;offset++){
        const angle=step*offset;
        const cos=Math.cos(angle),sin=Math.sin(angle);
        const even=start+offset,odd=even+half;
        const oddReal=real[odd]*cos-imag[odd]*sin;
        const oddImag=real[odd]*sin+imag[odd]*cos;
        const evenReal=real[even],evenImag=imag[even];
        real[even]=evenReal+oddReal;
        imag[even]=evenImag+oddImag;
        real[odd]=evenReal-oddReal;
        imag[odd]=evenImag-oddImag;
      }
    }
  }

  const spectrum=new Float32Array(size/2);
  const scale=2/size;
  for(let bin=0;bin<spectrum.length;bin++){
    const magnitude=Math.hypot(real[bin],imag[bin])*scale;
    spectrum[bin]=20*Math.log10(Math.max(1e-12,magnitude));
  }
  return spectrum;
}
