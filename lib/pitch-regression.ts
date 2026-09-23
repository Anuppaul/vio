import { detectMpm } from './mpm';
import { detectPitch } from './yin';

export type SyntheticPitchCase = {
  name: string;
  expectedHz: number | null;
  maxCents: number;
  samples: Float32Array;
};

export type SyntheticDetectorResult = {
  frequency: number | null;
  clarity: number;
  centsError: number | null;
  pass: boolean;
};

export type SyntheticPitchCaseResult = {
  name: string;
  expectedHz: number | null;
  mpm: SyntheticDetectorResult;
  yin: SyntheticDetectorResult;
};

export const SYNTHETIC_SAMPLE_RATE=48000;
export const SYNTHETIC_FRAME_SIZE=8192;
const SAMPLE_RATE=SYNTHETIC_SAMPLE_RATE;
const FRAME_SIZE=SYNTHETIC_FRAME_SIZE;

function centsError(actual:number,expected:number){
  return 1200*Math.log2(actual/expected);
}

export function syntheticNoise(length=FRAME_SIZE,seed=0x51f15e){
  let state=seed>>>0;
  const out=new Float32Array(length);
  for(let i=0;i<length;i++){
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    out[i]=((state/0xffffffff)*2-1);
  }
  return out;
}

export function syntheticHarmonicTone(
  frequency:number,
  harmonics:number[],
  {
    vibratoCents=0,
    vibratoHz=5.2,
    amplitude=.72,
    phase=.37
  }:{
    vibratoCents?:number;
    vibratoHz?:number;
    amplitude?:number;
    phase?:number;
  }={}
){
  const out=new Float32Array(FRAME_SIZE);
  let oscillatorPhase=phase;
  for(let i=0;i<out.length;i++){
    const t=i/SAMPLE_RATE;
    const cents=vibratoCents*Math.sin(2*Math.PI*vibratoHz*t);
    const instantaneous=frequency*Math.pow(2,cents/1200);
    oscillatorPhase+=2*Math.PI*instantaneous/SAMPLE_RATE;
    let value=0;
    for(let harmonic=1;harmonic<=harmonics.length;harmonic++){
      value+=harmonics[harmonic-1]*Math.sin(oscillatorPhase*harmonic+harmonic*.11);
    }
    out[i]=value*amplitude;
  }
  normalizeSynthetic(out,.88);
  return out;
}

export function normalizeSynthetic(samples:Float32Array,target=.9){
  let peak=0;
  for(const value of samples)peak=Math.max(peak,Math.abs(value));
  if(peak<=0||peak<=target)return samples;
  const gain=target/peak;
  for(let i=0;i<samples.length;i++)samples[i]*=gain;
  return samples;
}

export function mixSynthetic(
  base:Float32Array,
  additions:Array<{samples:Float32Array;gain:number}>
){
  const out=new Float32Array(base);
  for(const addition of additions){
    const length=Math.min(out.length,addition.samples.length);
    for(let i=0;i<length;i++)out[i]+=addition.samples[i]*addition.gain;
  }
  return normalizeSynthetic(out,.92);
}

export function syntheticSine(frequency:number,amplitude=.8,length=FRAME_SIZE){
  const out=new Float32Array(length);
  for(let i=0;i<out.length;i++)out[i]=Math.sin(2*Math.PI*frequency*i/SAMPLE_RATE)*amplitude;
  return out;
}

export function buildSyntheticPitchCases():SyntheticPitchCase[]{
  const noise=syntheticNoise(FRAME_SIZE);
  const hum50=syntheticSine(50,.8);
  const hum100=syntheticSine(100,.72);
  return [
    {
      name:'A4 pure sine',
      expectedHz:440,
      maxCents:4,
      samples:syntheticSine(440,.78)
    },
    {
      name:'A4 violin-like harmonic stack',
      expectedHz:440,
      maxCents:7,
      samples:syntheticHarmonicTone(440,[.32,1,.76,.55,.38,.28,.20,.14])
    },
    {
      name:'D4 weak fundamental strong overtones',
      expectedHz:293.6648,
      maxCents:10,
      samples:syntheticHarmonicTone(293.6648,[.14,1,.82,.61,.42,.31,.22,.16])
    },
    {
      name:'G3 bowed vibrato',
      expectedHz:195.9977,
      maxCents:24,
      samples:syntheticHarmonicTone(195.9977,[.58,1,.72,.48,.30,.22],{
        vibratoCents:22,
        vibratoHz:5.4
      })
    },
    {
      name:'G3 with fan hum and broadband noise',
      expectedHz:195.9977,
      maxCents:28,
      samples:mixSynthetic(
        new Float32Array(FRAME_SIZE),
        [
          {
            samples:syntheticHarmonicTone(
              195.9977,
              [.52,1,.74,.50,.34,.23,.16]
            ),
            gain:.62
          },
          {samples:hum50,gain:.28},
          {samples:hum100,gain:.20},
          {samples:noise,gain:.16}
        ]
      )
    },
    {
      name:'E5 octave trap strong second harmonic',
      expectedHz:659.2551,
      maxCents:10,
      samples:syntheticHarmonicTone(659.2551,[.20,1,.58,.43,.29,.18])
    },
    {
      name:'A4 with 50 Hz mains hum',
      expectedHz:440,
      maxCents:12,
      samples:mixSynthetic(
        syntheticHarmonicTone(440,[.42,1,.68,.44,.25]),
        [{samples:hum50,gain:.32}]
      )
    },
    {
      name:'A4 with broadband room noise',
      expectedHz:440,
      maxCents:15,
      samples:mixSynthetic(
        syntheticHarmonicTone(440,[.46,1,.70,.47,.31]),
        [{samples:noise,gain:.18}]
      )
    },
    {
      name:'50 Hz hum only must not become a musical pitch',
      expectedHz:null,
      maxCents:0,
      samples:mixSynthetic(hum50,[{samples:noise,gain:.025}])
    },
    {
      name:'Broadband noise only must remain unpitched',
      expectedHz:null,
      maxCents:0,
      samples:normalizeSynthetic(noise,.45)
    }
  ];
}

function resultFor(
  result:{frequency:number;clarity:number}|null,
  expectedHz:number|null,
  maxCents:number
):SyntheticDetectorResult{
  if(expectedHz===null){
    return {
      frequency:result?.frequency??null,
      clarity:result?.clarity??0,
      centsError:null,
      pass:result===null||result.clarity<.58
    };
  }
  if(!result){
    return {frequency:null,clarity:0,centsError:null,pass:false};
  }
  const error=centsError(result.frequency,expectedHz);
  return {
    frequency:result.frequency,
    clarity:result.clarity,
    centsError:error,
    pass:Math.abs(error)<=maxCents
  };
}

/**
 * Deterministic, dependency-free DSP regression fixtures.
 *
 * This function intentionally does not run automatically or from CI. It gives
 * local/manual validation code a stable set of violin-like octave traps,
 * vibrato, mains hum and broadband-noise cases before detector thresholds are
 * changed.
 */
export function runSyntheticPitchRegression():SyntheticPitchCaseResult[]{
  return buildSyntheticPitchCases().map(testCase=>{
    const mpm=detectMpm(testCase.samples,SAMPLE_RATE,55,2000);
    const yin=detectPitch(testCase.samples,SAMPLE_RATE,55,2000);
    return {
      name:testCase.name,
      expectedHz:testCase.expectedHz,
      mpm:resultFor(mpm,testCase.expectedHz,testCase.maxCents),
      yin:resultFor(yin,testCase.expectedHz,testCase.maxCents)
    };
  });
}
