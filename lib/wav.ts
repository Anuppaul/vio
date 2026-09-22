export type DecodedWav={
  sampleRate:number;
  channels:number;
  bitsPerSample:number;
  format:'pcm'|'float';
  samples:Float32Array;
  durationSeconds:number;
};

function readAscii(view:DataView,offset:number,length:number){
  let value='';
  for(let i=0;i<length;i++)value+=String.fromCharCode(view.getUint8(offset+i));
  return value;
}

function signed24(view:DataView,offset:number){
  let value=
    view.getUint8(offset)|
    (view.getUint8(offset+1)<<8)|
    (view.getUint8(offset+2)<<16);
  if(value&0x800000)value|=0xff000000;
  return value;
}

export function decodeWav(input:ArrayBuffer|Uint8Array):DecodedWav{
  const bytes=input instanceof Uint8Array
    ?new Uint8Array(input.buffer,input.byteOffset,input.byteLength)
    :new Uint8Array(input);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

  if(view.byteLength<44)throw new Error('WAV file is too small');
  const riff=readAscii(view,0,4);
  if(riff!=='RIFF'&&riff!=='RF64')throw new Error('Only RIFF/RF64 WAV files are supported');
  if(readAscii(view,8,4)!=='WAVE')throw new Error('Invalid WAV container');

  let formatCode=0;
  let channels=0;
  let sampleRate=0;
  let blockAlign=0;
  let bitsPerSample=0;
  let dataOffset=-1;
  let dataLength=0;

  let offset=12;
  while(offset+8<=view.byteLength){
    const id=readAscii(view,offset,4);
    const size=view.getUint32(offset+4,true);
    const start=offset+8;
    if(start+size>view.byteLength)break;

    if(id==='fmt '){
      if(size<16)throw new Error('Invalid WAV fmt chunk');
      formatCode=view.getUint16(start,true);
      channels=view.getUint16(start+2,true);
      sampleRate=view.getUint32(start+4,true);
      blockAlign=view.getUint16(start+12,true);
      bitsPerSample=view.getUint16(start+14,true);

      if(formatCode===0xfffe&&size>=40){
        const validBits=view.getUint16(start+18,true);
        if(validBits>0)bitsPerSample=validBits;
        const subFormat=view.getUint16(start+24,true);
        if(subFormat===1||subFormat===3)formatCode=subFormat;
      }
    }else if(id==='data'){
      dataOffset=start;
      dataLength=size;
    }

    offset=start+size+(size&1);
  }

  if(!channels||!sampleRate||!blockAlign||!bitsPerSample)throw new Error('WAV format metadata is missing');
  if(dataOffset<0||dataLength<=0)throw new Error('WAV data chunk is missing');
  if(formatCode!==1&&formatCode!==3)throw new Error(`Unsupported WAV encoding: ${formatCode}`);

  const bytesPerSample=Math.ceil(bitsPerSample/8);
  if(blockAlign<channels*bytesPerSample)throw new Error('Invalid WAV block alignment');
  const frameCount=Math.floor(dataLength/blockAlign);
  const mono=new Float32Array(frameCount);

  for(let frame=0;frame<frameCount;frame++){
    const frameOffset=dataOffset+frame*blockAlign;
    let sum=0;
    for(let channel=0;channel<channels;channel++){
      const sampleOffset=frameOffset+channel*bytesPerSample;
      let value=0;

      if(formatCode===3){
        if(bitsPerSample===32)value=view.getFloat32(sampleOffset,true);
        else if(bitsPerSample===64)value=view.getFloat64(sampleOffset,true);
        else throw new Error(`Unsupported float WAV bit depth: ${bitsPerSample}`);
      }else{
        if(bitsPerSample===8)value=(view.getUint8(sampleOffset)-128)/128;
        else if(bitsPerSample===16)value=view.getInt16(sampleOffset,true)/32768;
        else if(bitsPerSample===24)value=signed24(view,sampleOffset)/8388608;
        else if(bitsPerSample===32)value=view.getInt32(sampleOffset,true)/2147483648;
        else throw new Error(`Unsupported PCM WAV bit depth: ${bitsPerSample}`);
      }

      sum+=Math.max(-1,Math.min(1,value));
    }
    mono[frame]=sum/channels;
  }

  return{
    sampleRate,
    channels,
    bitsPerSample,
    format:formatCode===3?'float':'pcm',
    samples:mono,
    durationSeconds:frameCount/sampleRate
  };
}

export function resampleLinear(
  input:Float32Array,
  sourceRate:number,
  targetRate:number
){
  if(!(sourceRate>0)||!(targetRate>0))throw new Error('Sample rates must be positive');
  if(sourceRate===targetRate)return new Float32Array(input);
  if(!input.length)return new Float32Array(0);

  const outputLength=Math.max(1,Math.round(input.length*targetRate/sourceRate));
  const output=new Float32Array(outputLength);
  const scale=sourceRate/targetRate;

  for(let i=0;i<outputLength;i++){
    const position=i*scale;
    const left=Math.min(input.length-1,Math.floor(position));
    const right=Math.min(input.length-1,left+1);
    const fraction=position-left;
    output[i]=input[left]*(1-fraction)+input[right]*fraction;
  }
  return output;
}
