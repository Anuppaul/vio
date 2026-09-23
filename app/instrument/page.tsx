import type { Metadata } from 'next';
import Instrument from '@/components/Instrument';

export const metadata: Metadata = { title: 'Instrument' };

export default function Page(){
  return <main className="page"><Instrument/></main>;
}
