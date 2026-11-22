import type { Metadata } from 'next';
import Baithak from '@/components/Baithak';
import '../riyaaz-instruments.css';
import './harmonium.css';

export const metadata: Metadata = { title: 'Harmonium' };

export default function Page() {
  return <main className="page"><Baithak instrument="harmonium" /></main>;
}
