import type { Metadata } from 'next';
import ScalePractice from '@/components/ScalePractice';

export const metadata: Metadata = { title: 'Scale Practice' };

export default function Page(){return <main className="page"><ScalePractice/></main>}
