import type { Metadata } from 'next';
import Metronome from '@/components/Metronome';
export const metadata: Metadata = { title: 'Metronome' };
export default function Page(){return <main className="page"><Metronome/></main>}
