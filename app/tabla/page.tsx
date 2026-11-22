import type { Metadata } from 'next';
import Baithak from '@/components/Baithak';
import '../riyaaz-instruments.css';

export const metadata: Metadata = { title: 'Tabla' };

export default function Page() {
  return <main className="page"><Baithak instrument="tabla" /></main>;
}
