import { Capacitor, registerPlugin } from '@capacitor/core';

export type NativeAudioStatus = {
  mode: 'none'|'tanpura'|'metronome'|'ear';
  playing: boolean;
  pattern: 'sa-pa'|'sa-ma';
  key: string;
  sound: 'click'|'tabla'|'drum';
  tone: 'natural'|'beep';
  bpm: number;
  beats: number;
  subdivision: number;
  midi: number;
  accent: boolean;
  loop: boolean;
  volume: number;
  error: string;
};

type NativeAudioPlugin = {
  playTanpura(options: { pattern:'sa-pa'|'sa-ma'; key:string; volume:number }):Promise<{dispatched:boolean}>;
  playMetronome(options:{bpm:number; beats:number; subdivision:number; sound:'click'|'tabla'|'drum'; accent:boolean; volume:number}):Promise<{dispatched:boolean}>;
  playEar(options:{midi:number; tone:'natural'|'beep'; loop:boolean; volume:number}):Promise<{dispatched:boolean}>;
  stop():Promise<void>;
  setVolume(options:{volume:number}):Promise<void>;
  getStatus():Promise<NativeAudioStatus>;
  requestNotificationPermission():Promise<{granted:boolean}>;
};

let plugin:NativeAudioPlugin|null=null;

/** Native-only; browser/PWA and server rendering keep their existing WebAudio code. */
export function backgroundAudio():NativeAudioPlugin|null {
  if(typeof window==='undefined' || !Capacitor.isNativePlatform())return null;
  if(!Capacitor.isPluginAvailable('BackgroundAudio'))return null;
  if(!plugin)plugin=registerPlugin<NativeAudioPlugin>('BackgroundAudio');
  return plugin;
}

export async function nativeAudioStatus():Promise<NativeAudioStatus|null>{
  const native=backgroundAudio();
  if(!native)return null;
  return native.getStatus();
}

/** Ask once when the user presses Play. Denial never blocks audio itself. */
export async function prepareBackgroundNotification():Promise<void>{
  const native=backgroundAudio();
  if(!native)return;
  try{
    if(localStorage.getItem('vio-background-notification-asked')==='1')return;
    localStorage.setItem('vio-background-notification-asked','1');
  }catch{}
  try{await native.requestNotificationPermission()}catch{}
}
