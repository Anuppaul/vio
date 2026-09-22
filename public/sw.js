const VERSION='vio-pwa-v46';
const APP_CACHE=`${VERSION}-app`;
const AUDIO_CACHE=`${VERSION}-audio`;
const RUNTIME_CACHE=`${VERSION}-runtime`;

const ROUTES=['/','/sound-tuner','/scale-practice','/tanpura','/exercise','/metronome','/manifest.webmanifest'];
const EAR_NOTES=['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const EAR_AUDIO=[];
for(let octave=3;octave<=5;octave++) for(const note of EAR_NOTES) EAR_AUDIO.push(`/assets/ear/${note}${octave}.mp3`);
const EXERCISE_AUDIO=Array.from({length:61},(_,i)=>`/assets/exercise/midi-${i+36}.wav`);
const TAN_KEYS=['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const TANPURA_AUDIO=['sa-pa','sa-ma'].flatMap(pattern=>TAN_KEYS.map(key=>`/assets/tanpura/${pattern}_${key}.mp3`));
const METRONOME_AUDIO=[
  '/assets/metronome/click.wav','/assets/metronome/click-accent.wav',
  '/assets/metronome/tabla-na.wav','/assets/metronome/tabla-tin.wav','/assets/metronome/tabla-ge.wav',
  '/assets/metronome/drum-kick.wav','/assets/metronome/drum-snare.wav','/assets/metronome/drum-hihat.wav'
];
const ICONS=['/icon.png','/apple-icon.png','/icons/icon-192.png?v=13','/icons/icon-512.png?v=13'];
const AUDIO=[...EAR_AUDIO,...EXERCISE_AUDIO,...TANPURA_AUDIO,...METRONOME_AUDIO];

async function cacheOne(cache,url){
  try{
    const response=await fetch(url,{cache:'reload'});
    if(response.ok) await cache.put(url,response.clone());
    return response;
  }catch{return null;}
}

async function warmApp(){
  const cache=await caches.open(APP_CACHE);
  for(const url of [...ROUTES,...ICONS]){
    const response=await cacheOne(cache,url);
    if(!response||!response.headers.get('content-type')?.includes('text/html')) continue;
    try{
      const html=await response.clone().text();
      const urls=[...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map(m=>m[1])
        .filter(u=>u.startsWith('/_next/static/')||u.startsWith('/_next/image'));
      for(const asset of [...new Set(urls)]) await cacheOne(cache,asset);
    }catch{}
  }
}

async function warmAudio(){
  const cache=await caches.open(AUDIO_CACHE);
  const workers=6;
  let index=0;
  await Promise.all(Array.from({length:workers},async()=>{
    while(index<AUDIO.length){
      const current=AUDIO[index++];
      await cacheOne(cache,current);
    }
  }));
}

self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(Promise.all([warmApp(),warmAudio()]));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keep=new Set([APP_CACHE,AUDIO_CACHE,RUNTIME_CACHE]);
    for(const key of await caches.keys()) if(!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request){
  const cache=await caches.open(RUNTIME_CACHE);
  try{
    const response=await fetch(request);
    if(response.ok) await cache.put(request,response.clone());
    return response;
  }catch{
    return (await cache.match(request))||(await caches.match(request,{ignoreSearch:true}))||(await caches.match('/'));
  }
}

async function cacheFirst(request){
  const cached=await caches.match(request,{ignoreSearch:false});
  if(cached) return cached;
  try{
    const response=await fetch(request);
    if(response.ok){
      const cache=await caches.open(request.url.includes('/assets/')?AUDIO_CACHE:RUNTIME_CACHE);
      await cache.put(request,response.clone());
    }
    return response;
  }catch{
    const fallback=await caches.match(request,{ignoreSearch:true});
    if(fallback) return fallback;
    throw new Error('Offline resource unavailable');
  }
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin) return;

  if(request.mode==='navigate'){
    event.respondWith(networkFirst(request));
    return;
  }
  if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/icons/')||url.pathname.startsWith('/_next/static/')){
    event.respondWith(cacheFirst(request));
    return;
  }
  if(url.pathname.startsWith('/_next/')||url.searchParams.has('_rsc')){
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING') self.skipWaiting();
  if(event.data?.type==='REFRESH_OFFLINE') event.waitUntil(Promise.all([warmApp(),warmAudio()]));
});
