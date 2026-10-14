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
  if(ctx.state==='closed')throw new Error('Audio output was closed');
  if(ctx.state!=='running'){
    // A failed or indefinitely pending resume must never look like working
    // playback. This commonly happens when a WebKit WebView loses user gesture.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([
        ctx.resume(),
        new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Audio activation timed out; click Play again')),3500);
        })
      ]);
    }catch(error){
      const detail=error instanceof Error?error.message:'permission or audio backend failure';
      throw new Error('Audio output unavailable: '+detail);
    }finally{
      if(timer!==undefined)clearTimeout(timer);
    }
  }
  if(ctx.state!=='running')throw new Error('Audio output is suspended; click Play again');
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
