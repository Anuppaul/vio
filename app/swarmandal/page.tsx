import type { Metadata } from 'next';
import Baithak from '@/components/Baithak';
import '../riyaaz-instruments.css';
import './swarmandal.css';

export const metadata: Metadata = { title: 'Swarmandal' };

export default function Page() {
  return <main className="page"><Baithak instrument="swarmandal" /></main>;
}
