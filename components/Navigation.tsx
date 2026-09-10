'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';

const items = [
  { href: '/', label: 'Ear Tuner', icon: '♪' },
  { href: '/sound-tuner', label: 'Sound Tuner', icon: '◌' },
  { href: '/tanpura', label: 'Tanpura', icon: 'ॐ' },
  { href: '/exercise', label: 'Exercise', icon: '𝄞' },
  { href: '/metronome', label: 'Metronome', icon: '●' }
];

function offlineNavigate(event: MouseEvent<HTMLAnchorElement>, href: string){
  if(typeof navigator!=='undefined' && !navigator.onLine){
    event.preventDefault();
    window.location.assign(href);
  }
}

export default function Navigation() {
  const pathname = usePathname();
  return (
    <nav className="suite-nav" aria-label="VIO tools">
      <Link className="brand" href="/" aria-label="VIO home" onClick={event=>offlineNavigate(event,'/')}>
        <img src="/icon.png" alt="" aria-hidden="true" width="36" height="36" style={{width:36,height:36,objectFit:'contain',flex:'0 0 auto'}} />
        <b>VIO</b>
      </Link>
      <div className="nav-items">
        {items.map(item => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return <Link key={item.href} href={item.href} className={active ? 'active' : ''} title={item.label} onClick={event=>offlineNavigate(event,item.href)}><i>{item.icon}</i><span>{item.label}</span></Link>;
        })}
      </div>
    </nav>
  );
}
