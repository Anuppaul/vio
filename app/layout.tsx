import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Navigation from '@/components/Navigation';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VIO', template: '%s · VIO' },
  description: 'A focused violin practice toolkit.',
  robots: { index: false, follow: false, nocache: true }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Navigation />
        {children}
      </body>
    </html>
  );
}
