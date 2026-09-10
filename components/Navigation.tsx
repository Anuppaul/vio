'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/', label: 'Ear Tuner', icon: '♪' },
  { href: '/sound-tuner', label: 'Sound Tuner', icon: '◌' },
  { href: '/tanpura', label: 'Tanpura', icon: 'ॐ' },
  { href: '/exercise', label: 'Exercise', icon: '𝄞' },
  { href: '/metronome', label: 'Metronome', icon: '●' }
];

export default function Navigation() {
  const pathname = usePathname();
  return (
    <nav className="suite-nav" aria-label="VIO tools">
      <Link className="brand" href="/" aria-label="VIO home"><span>V</span><b>VIO</b></Link>
      <div className="nav-items">
        {items.map(item => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return <Link key={item.href} href={item.href} className={active ? 'active' : ''} title={item.label}><i>{item.icon}</i><span>{item.label}</span></Link>;
        })}
      </div>
    </nav>
  );
}
