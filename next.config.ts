import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: '/index.html', destination: '/', permanent: true },
      { source: '/sound-tuner.html', destination: '/sound-tuner', permanent: true },
      { source: '/tanpura.html', destination: '/tanpura', permanent: true },
      { source: '/exercise.html', destination: '/exercise', permanent: true },
      { source: '/metronome.html', destination: '/metronome', permanent: true }
    ];
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' }
        ]
      }
    ];
  }
};

export default nextConfig;
