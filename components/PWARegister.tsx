'use client';

import { useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type NativeUiPlugin={
  configureInsets():Promise<void>;
};

const NativeUi=registerPlugin<NativeUiPlugin>('NativePitch');

export default function PWARegister(){
  const [installPrompt,setInstallPrompt]=useState<InstallPromptEvent|null>(null);
  const [installed,setInstalled]=useState(false);

  useEffect(()=>{
    // Native assets already ship inside the APK. Do not create a second,
    // potentially stale PWA cache or show an install button inside Android.
    if(process.env.NEXT_PUBLIC_VIO_NATIVE === '1'){
      if(Capacitor.isNativePlatform())void NativeUi.configureInsets().catch(()=>{});
      return;
    }
    if('serviceWorker' in navigator&&window.isSecureContext){
      navigator.serviceWorker.register('/sw.js',{scope:'/'}).then(registration=>{
        registration.update().catch(()=>{});
      }).catch(()=>{});
    }

    const standalone=window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?:boolean}).standalone===true;
    setInstalled(standalone);

    const beforeInstall=(event:Event)=>{
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const appInstalled=()=>{setInstalled(true);setInstallPrompt(null)};
    window.addEventListener('beforeinstallprompt',beforeInstall);
    window.addEventListener('appinstalled',appInstalled);
    return()=>{
      window.removeEventListener('beforeinstallprompt',beforeInstall);
      window.removeEventListener('appinstalled',appInstalled);
    };
  },[]);

  async function install(){
    if(!installPrompt)return;
    await installPrompt.prompt();
    const result=await installPrompt.userChoice;
    if(result.outcome==='accepted')setInstallPrompt(null);
  }

  if(installed||!installPrompt)return null;
  return <button className="pwa-install" type="button" onClick={install} aria-label="Install VIO for offline use">Install VIO</button>;
}
