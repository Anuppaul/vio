export type BrowserAudioContextConstructor=typeof AudioContext;

export function browserAudioContextConstructor():BrowserAudioContextConstructor|undefined{
  if(typeof window==='undefined')return undefined;
  return window.AudioContext||(window as typeof window & {webkitAudioContext?:BrowserAudioContextConstructor}).webkitAudioContext;
}

export function createBrowserAudioContext(options:AudioContextOptions={latencyHint:'interactive'}):AudioContext|null{
  const AC=browserAudioContextConstructor();
  if(!AC)return null;
  try{return new AC(options)}
  catch{
    try{return new AC()}
    catch{return null}
  }
}

export async function resumeBrowserAudio(ctx:AudioContext){
  if(ctx.state==='closed')throw new Error('Audio context is closed');
  if(ctx.state!=='running'){
    try{await ctx.resume()}catch{}
  }
  return ctx;
}

function shouldRetryMicrophone(error:unknown){
  const name=error instanceof DOMException?error.name:error instanceof Error?error.name:'';
  return !['NotAllowedError','SecurityError','NotFoundError','NotReadableError'].includes(name);
}

export async function requestRawMicrophone():Promise<MediaStream>{
  if(typeof window!=='undefined'&&!window.isSecureContext)throw new Error('Microphone requires HTTPS or localhost');
  const media=typeof navigator!=='undefined'?navigator.mediaDevices:undefined;
  if(!media?.getUserMedia)throw new Error('Microphone API unavailable in this browser');

  const supported=typeof media.getSupportedConstraints==='function'?media.getSupportedConstraints():{};
  const audio:MediaTrackConstraints={};
  if(supported.echoCancellation)audio.echoCancellation=false;
  if(supported.noiseSuppression)audio.noiseSuppression=false;
  if(supported.autoGainControl)audio.autoGainControl=false;
  if(supported.channelCount)audio.channelCount={ideal:1};

  let stream:MediaStream;
  try{
    stream=await media.getUserMedia({audio:Object.keys(audio).length?audio:true,video:false});
  }catch(error){
    if(!shouldRetryMicrophone(error))throw error;
    stream=await media.getUserMedia({audio:true,video:false});
  }

  const track=stream.getAudioTracks()[0];
  if(track&&Object.keys(audio).length&&typeof track.applyConstraints==='function'){
    try{await track.applyConstraints(audio)}catch{}
  }
  return stream;
}
