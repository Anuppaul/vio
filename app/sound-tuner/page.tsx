import type { Metadata } from 'next';
import SoundTuner from '@/components/SoundTuner';
export const metadata: Metadata = { title: 'Sound Tuner' };
export default function Page(){return <main className="page"><SoundTuner/></main>}
