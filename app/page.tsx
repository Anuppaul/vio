import type { Metadata } from 'next';
import EarTuner from '@/components/EarTuner';
export const metadata: Metadata = { title: 'Ear Tuner' };
export default function Page(){return <main className="page"><EarTuner/></main>}
