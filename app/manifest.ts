import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'VIO · Violin Practice Tools',
    short_name: 'VIO',
    description: 'Offline-ready violin tuner, tanpura, note exercise and metronome.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f8f9fd',
    theme_color: '#7c6ff1',
    categories: ['music', 'education', 'utilities'],
    icons: [
      { src: '/icon.png', sizes: 'any', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192.png?v=13', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png?v=13', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png?v=13', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
