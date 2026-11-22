const SWARS = ['Sa', 're', 'Re', 'ga', 'Ga', 'Ma', 'Ma♯', 'Pa', 'dha', 'Dha', 'ni', 'Ni'];
// Pitch offsets from Sa (cents), using the swars of both directions in each preset.
export const RAGAS = {
  asavari: { label: 'Asavari', thaat: 'Asavari', pitches: [0, 204, 294, 498, 702, 814, 996] },
  darbari_kanada: { label: 'Darbari Kanada', thaat: 'Asavari', pitches: [0, 204, 294, 498, 702, 792, 996] },
  jaunpuri: { label: 'Jaunpuri', thaat: 'Asavari', pitches: [0, 204, 294, 498, 702, 814, 996] },
  ahir_bhairav: { label: 'Ahir Bhairav', thaat: 'Bhairav', pitches: [0, 112, 386, 498, 702, 884, 996] },
  bhairav: { label: 'Bhairav', thaat: 'Bhairav', pitches: [0, 112, 386, 498, 702, 814, 1088] },
  bhairavi: { label: 'Bhairavi', thaat: 'Bhairavi', pitches: [0, 112, 316, 498, 702, 814, 1018] },
  malkauns: { label: 'Malkauns', thaat: 'Bhairavi', pitches: [0, 316, 498, 814, 1018] },
  alhaiya_bilawal: { label: 'Alhaiya Bilawal', thaat: 'Bilawal', pitches: [0, 204, 294, 386, 498, 702, 884, 1088] },
  bihag: { label: 'Bihag', thaat: 'Bilawal', pitches: [0, 204, 386, 498, 612, 702, 884, 1088] },
  bilawal: { label: 'Bilawal', thaat: 'Bilawal', pitches: [0, 204, 386, 498, 702, 884, 1088] },
  durga: { label: 'Durga', thaat: 'Bilawal', pitches: [0, 204, 498, 702, 884] },
  hamsadhwani: { label: 'Hamsadhwani', thaat: 'Bilawal', pitches: [0, 204, 386, 702, 1088] },
  hansdhwani: { label: 'Hansdhwani', thaat: 'Bilawal', pitches: [0, 204, 386, 702, 1088] },
  pahadi: { label: 'Pahadi', thaat: 'Bilawal', pitches: [0, 204, 386, 498, 702, 884, 1088] },
  shankara: { label: 'Shankara', thaat: 'Bilawal', pitches: [0, 204, 386, 702, 884, 1088] },
  bageshri: { label: 'Bageshri', thaat: 'Kafi', pitches: [0, 204, 316, 498, 702, 884, 1018] },
  bhimpalasi: { label: 'Bhimpalasi', thaat: 'Kafi', pitches: [0, 204, 316, 498, 702, 884, 1018] },
  kafi: { label: 'Kafi', thaat: 'Kafi', pitches: [0, 204, 316, 498, 702, 884, 1018] },
  pilu: { label: 'Pilu', thaat: 'Kafi', pitches: [0, 204, 316, 498, 702, 884, 1018] },
  shivranjani: { label: 'Shivranjani', thaat: 'Kafi', pitches: [0, 204, 316, 702, 884] },
  vrindavani_sarang: { label: 'Vrindavani Sarang', thaat: 'Kafi', pitches: [0, 204, 498, 702, 884, 996] },
  bhupali: { label: 'Bhupali', thaat: 'Kalyan', pitches: [0, 204, 386, 702, 884] },
  kedar: { label: 'Kedar', thaat: 'Kalyan', pitches: [0, 204, 386, 498, 612, 702, 884, 1088] },
  yaman: { label: 'Yaman', thaat: 'Kalyan', pitches: [0, 204, 386, 612, 702, 884, 1088] },
  des: { label: 'Des', thaat: 'Khamaj', pitches: [0, 204, 386, 498, 702, 884, 996, 1088] },
  khamaj: { label: 'Khamaj', thaat: 'Khamaj', pitches: [0, 204, 386, 498, 702, 884, 996, 1088] },
  marwa: { label: 'Marwa', thaat: 'Marwa', pitches: [0, 112, 386, 612, 884, 1088] },
  puriya: { label: 'Puriya', thaat: 'Marwa', pitches: [0, 112, 386, 612, 884, 1088] },
  poorvi: { label: 'Poorvi', thaat: 'Poorvi', pitches: [0, 112, 386, 612, 702, 814, 1088] },
  puriya_dhanashri: { label: 'Puriya Dhanashri', thaat: 'Poorvi', pitches: [0, 112, 386, 612, 702, 814, 1088] },
  multani: { label: 'Multani', thaat: 'Todi', pitches: [0, 112, 294, 590, 702, 814, 1088] },
  todi: { label: 'Todi', thaat: 'Todi', pitches: [0, 112, 294, 590, 702, 814, 1088] },
} as const;

export type Raga = keyof typeof RAGAS;

export const RAGA_GROUPS = Object.entries(RAGAS).reduce<Record<string, { id: string; label: string }[]>>(
  (groups, [id, { label, thaat }]) => {
    (groups[thaat] ??= []).push({ id, label });
    return groups;
  }, {},
);

export function tunedStrings(sa: number, raga: Raga) {
  const { pitches } = RAGAS[raga];
  return Array.from({ length: 32 }, (_, index) => {
    const octave = Math.floor(index / pitches.length);
    const pitch = pitches[index % pitches.length];
    return {
      frequency: sa * 2 ** (octave - 1 + pitch / 1200),
      name: SWARS[Math.round(pitch / 100)],
      octave,
    };
  });
}

export type SwarmandalSound = 'acoustic' | 'pad';

export function renderPluck(context: AudioContext, frequency: number, duration = 1.5, sound: SwarmandalSound = 'acoustic') {
  const sampleRate = 24000;
  const buffer = context.createBuffer(1, sampleRate * duration, sampleRate);
  const pcm = buffer.getChannelData(0);
  // A plucked string excites several modes, with higher harmonics decaying faster.
  const harmonics = Math.min(sound === 'pad' ? 5 : 12, Math.floor(sampleRate * .45 / frequency));
  for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
    const angle = 2 * Math.PI * harmonic * frequency / sampleRate;
    const resonance = 2 * Math.cos(angle);
    const decay = Math.exp(-(4.2 + harmonic * 1.05) / (sampleRate * duration));
    let previous = 0;
    let current = Math.sin(angle);
    let gain = sound === 'pad' ? .8 / harmonic ** 2 : Math.sin(harmonic * Math.PI * .21) / (harmonic * .9);
    for (let index = 0; index < pcm.length; index++) {
      pcm[index] += previous * gain;
      const next = resonance * current - previous;
      previous = current;
      current = next;
      gain *= decay;
    }
  }
  for (let index = 0; index < pcm.length; index++) {
    pcm[index] *= Math.min(1, index / (sound === 'pad' ? 2400 : 72), (pcm.length - 1 - index) / 2400) * .39;
  }
  return buffer;
}
