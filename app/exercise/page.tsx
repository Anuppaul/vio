import type { Metadata } from 'next';
import Exercise from '@/components/Exercise';
export const metadata: Metadata = { title: 'Exercise' };
export default function Page(){return <main className="page exercise-page"><Exercise/></main>}
