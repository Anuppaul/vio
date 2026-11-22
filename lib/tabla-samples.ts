import catalog from '@/public/assets/tabla/samples.json';

export type Stroke = keyof typeof catalog;
type Sample = { file: string; rate?: number };
type Take = { buffer: AudioBuffer; rate: number };
type Bank = { samples: Take[]; used: Set<Take>; last?: Take };

export async function loadTablaSamples(context: AudioContext, signal: AbortSignal) {
  const entries = Object.entries(catalog) as [Stroke, Sample[]][];
  const banks = new Map<Stroke, Bank>(entries.map(([stroke]) => [
    stroke, { samples: [], used: new Set() },
  ]));

  async function load(stroke: Stroke, sample: Sample, primary = false) {
    try {
      const response = await fetch(`/assets/tabla/${sample.file}`, { signal });
      if (!response.ok) throw new Error(`Missing tabla sample: ${sample.file}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (signal.aborted) return;
      // Keep the original stroke level and tame unusually hot alternate takes.
      if (!primary) {
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
        }
        if (peak > .8) {
          const gain = .8 / peak;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i++) data[i] *= gain;
          }
        }
      }
      banks.get(stroke)!.samples.push({ buffer, rate: sample.rate ?? 1 });
    } catch (error) {
      if (primary) throw error;
      // A missing alternate can still use the recordings already available for its stroke.
    }
  }

  await Promise.all(entries.flatMap(([stroke, [primary, alternate]]) => [
    load(stroke, primary, true),
    load(stroke, alternate),
  ]));

  // Playback can start with two takes per stroke while the rest arrive in the background.
  const remaining = entries.flatMap(([stroke, samples]) =>
    samples.slice(2).map(sample => ({ stroke, sample })));
  let next = 0;
  for (let worker = 0; worker < 4; worker++) void (async () => {
    while (!signal.aborted && next < remaining.length) {
      const { stroke, sample } = remaining[next++];
      await load(stroke, sample);
    }
  })();

  return (stroke: Stroke): Take => {
    const bank = banks.get(stroke)!;
    if (bank.used.size === bank.samples.length) bank.used.clear();
    const unused = bank.samples.filter(take => !bank.used.has(take));
    const alternatives = unused.filter(take => take !== bank.last);
    const picks = alternatives.length ? alternatives : unused;
    const take = picks[Math.floor(Math.random() * picks.length)];
    bank.used.add(take);
    bank.last = take;
    return take;
  };
}
