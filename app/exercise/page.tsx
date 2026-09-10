import type { Metadata } from 'next';
import Exercise from '@/components/Exercise';
export const metadata: Metadata = { title: 'Exercise' };
export default function Page(){return <main className="page"><div className="page-head"><div><p className="eyebrow">Practice</p><h1>Exercise</h1></div></div><Exercise/></main>}
