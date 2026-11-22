import type { Metadata } from 'next';
import Baithak from '@/components/Baithak';
import '../riyaaz-instruments.css';
import './harmonium.css';
import './baithak.css';

export const metadata: Metadata = { title: 'Taalmala' };

export default function Page() {
  return <main className="page"><Baithak /></main>;
}
