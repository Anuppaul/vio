import { createBrowserAudioContext } from './browser-audio';

type Mix = { context: AudioContext; output: GainNode };

/** Route the Baithak instruments through one audio context and speaker output. */
export class BaithakAudio {
  private mix: Mix | null = null;

  get(): Mix | null {
    if (this.mix) return this.mix;
    const context = createBrowserAudioContext();
    if (!context) return null;
    const output = context.createGain();
    output.connect(context.destination);
    return this.mix = { context, output };
  }

  close() {
    const mix = this.mix;
    this.mix = null;
    if (mix) void mix.context.close().catch(() => {});
  }
}
