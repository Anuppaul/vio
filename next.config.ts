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
  }
};

export default nextConfig;
