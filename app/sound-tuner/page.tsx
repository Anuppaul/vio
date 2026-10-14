import type { Metadata } from 'next';
import SoundTuner from '@/components/SoundTuner';
import DesktopAudioCheck from '@/components/DesktopAudioCheck';
export const metadata: Metadata = { title: 'Sound Tuner' };
export default function Page(){return <main className="page"><SoundTuner/>{process.env.NEXT_PUBLIC_VIO_DESKTOP==='1'&&<DesktopAudioCheck/>}</main>}
