'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MouseEvent } from 'react';

const nativeBuild = process.env.NEXT_PUBLIC_VIO_NATIVE === '1';
type NativeUiPlugin={setOrientation(options:{mode:'unspecified'}):Promise<void>};
const NativeUi=registerPlugin<NativeUiPlugin>('NativePitch');
const items = [
  { href: '/', label: 'Ear Tuner', icon: '♪' },
  { href: '/sound-tuner', label: 'Sound Tuner', icon: '◌' },
  { href: '/scale-practice', label: 'Scale Practice', icon: 'সা' },
  { href: '/tanpura', label: 'Tanpura', icon: 'ॐ' },
  { href: '/exercise', label: 'Exercise', icon: '𝄞' },
  { href: '/metronome', label: 'Metronome', icon: '●' },
  { href: '/instrument', label: 'Instrument', icon: '≈' }
];

function offlineNavigate(event: MouseEvent<HTMLAnchorElement>, href: string){
  if(typeof navigator!=='undefined' && !navigator.onLine){
    event.preventDefault();
    window.location.assign(href);
  }
}

function nativeNavigate(event: MouseEvent<HTMLAnchorElement>, href: string){
  event.preventDefault();
  if(typeof document==='undefined')return;
  if(document.documentElement.classList.contains('vio-page-leaving'))return;
  document.documentElement.classList.add('vio-page-leaving');
  if(Capacitor.isNativePlatform())void NativeUi.setOrientation({mode:'unspecified'}).catch(()=>{});
  window.setTimeout(()=>window.location.assign(href),115);
}

export default function Navigation() {
  const rawPathname = usePathname();
  const pathname = rawPathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  const brand = <>
    <img src="/icon.png" alt="" aria-hidden="true" width="36" height="36" style={{width:36,height:36,objectFit:'contain',flex:'0 0 auto'}} />
    <b>VIO</b>
  </>;
  return (
    <nav className="suite-nav" aria-label="VIO tools">
      {nativeBuild ? <a className="brand" href="/index.html" aria-label="VIO home" onClick={event=>nativeNavigate(event,'/index.html')}>{brand}</a> :
        <Link className="brand" href="/" aria-label="VIO home" onClick={event=>offlineNavigate(event,'/')}>{brand}</Link>}
      <div className="nav-items">
        {items.map(item => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const content = <><i>{item.icon}</i><span>{item.label}</span></>;
          // Explicit local HTML documents avoid Capacitor's SPA index fallback
          // and do not need a Next server or a service worker in airplane mode.
          return nativeBuild ?
            <a key={item.href} href={item.href==='/'?'/index.html':`${item.href}.html`} className={active?'active':''} title={item.label} onClick={event=>nativeNavigate(event,item.href==='/'?'/index.html':`${item.href}.html`)}>{content}</a> :
            <Link key={item.href} href={item.href} className={active?'active':''} title={item.label} onClick={event=>offlineNavigate(event,item.href)}>{content}</Link>;
        })}
      </div>
    </nav>
  );
}
