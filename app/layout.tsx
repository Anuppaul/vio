import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Navigation from '@/components/Navigation';
import PWARegister from '@/components/PWARegister';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VIO', template: '%s · VIO' },
  description: 'A focused violin practice toolkit.',
  manifest: '/manifest.webmanifest',
  themeColor: '#7c6ff1',
  appleWebApp: { capable: true, title: 'VIO', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }]
  },
  robots: { index: false, follow: false, nocache: true }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Navigation />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
