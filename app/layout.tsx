import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Navigation from '@/components/Navigation';
import PWARegister from '@/components/PWARegister';
import './globals.css';
import './pwa.css';
import './tuner-jelly.css';
import './ear-mobile.css';
import './exercise-range.css';
import './exercise-musictheory.css';
import './scale-practice.css';
import './native.css';

export const metadata: Metadata = {
  title: { default: 'VIO', template: '%s · VIO' },
  description: 'A focused violin practice toolkit.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'VIO', statusBarStyle: 'default' },
  robots: { index: false, follow: false, nocache: true }
};

export const viewport: Viewport = {
  themeColor: '#7c6ff1',
  colorScheme: 'light',
  ...(process.env.NEXT_PUBLIC_VIO_NATIVE === '1' ? { viewportFit: 'cover' as const } : {})
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={process.env.NEXT_PUBLIC_VIO_NATIVE === '1' ? 'vio-native' : undefined}>
      <body>
        <Navigation />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
