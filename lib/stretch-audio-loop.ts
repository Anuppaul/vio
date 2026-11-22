/** Change the duration of a recorded loop without resampling its pitch. */
export function stretchAudioLoop(
  context: BaseAudioContext,
  source: AudioBuffer,
  start: number,
  end: number,
  speed: number,
) {
  const sampleRate = source.sampleRate;
  const first = Math.round(start * sampleRate);
  const length = Math.round(end * sampleRate) - first;
  const outputLength = Math.max(1, Math.round(length / speed));
  const output = context.createBuffer(source.numberOfChannels, outputLength, sampleRate);
  const inputs = Array.from({ length: source.numberOfChannels }, (_, channel) =>
    source.getChannelData(channel).subarray(first, first + length));
  const channels = Array.from({ length: output.numberOfChannels }, (_, channel) => output.getChannelData(channel));
  const overlap = Math.min(Math.round(.025 * sampleRate), length, outputLength);
  const radius = Math.min(Math.round(.012 * sampleRate), length - 1);
  const guide = inputs[0];
  const wrap = (index: number) => ((index % length) + length) % length;
  const stride = Math.max(1, Math.round(sampleRate / 8000));

  function alignedStart(expected: number, previous: number) {
    let best = expected;
    let bestScore = -Infinity;
    function search(from: number, to: number, step: number) {
      for (let candidate = from; candidate <= to; candidate += step) {
        let dot = 0;
        let previousPower = 0;
        let candidatePower = 0;
        for (let offset = 0; offset < overlap; offset += stride * 3) {
          const reference = guide[wrap(previous + overlap + offset)];
          const next = guide[wrap(candidate + offset)];
          dot += reference * next;
          previousPower += reference * reference;
          candidatePower += next * next;
        }
        const score = dot / Math.sqrt(previousPower * candidatePower + 1e-16)
          - .015 * Math.abs(candidate - expected) / Math.max(1, radius);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    search(expected - radius, expected + radius, stride);
    search(Math.max(expected - radius, best - stride), Math.min(expected + radius, best + stride), 1);
    return best;
  }

  for (const [channel, signal] of channels.entries()) {
    signal.set(inputs[channel].subarray(0, overlap));
  }

  let previous = 0;
  for (let position = overlap; position < outputLength; position += overlap) {
    const expected = Math.round(position * speed);
    const next = alignedStart(expected, previous);
    const count = Math.min(overlap, outputLength - position);
    for (const [channel, signal] of channels.entries()) {
      const input = inputs[channel];
      for (let offset = 0; offset < count; offset++) {
        const weight = offset / overlap;
        const tail = input[wrap(previous + overlap + offset)];
        const head = input[wrap(next + offset)];
        signal[position + offset] = tail + (head - tail) * weight;
      }
    }
    previous = next;
  }

  // Bridge the seam using the start's preceding samples from the original loop.
  const seam = Math.min(Math.round(.008 * sampleRate), Math.floor(outputLength / 2), length);
  for (const [channel, signal] of channels.entries()) {
    for (let offset = 0; offset < seam; offset++) {
      const index = outputLength - seam + offset;
      const weight = (offset + 1) / seam;
      const originalTail = inputs[channel][length - seam + offset];
      signal[index] += (originalTail - signal[index]) * weight;
    }
  }

  return output;
}
