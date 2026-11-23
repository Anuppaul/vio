import { createBrowserAudioContext } from './browser-audio';

type Mix = { context: AudioContext; output: GainNode };
type PlaybackSession = { type: string };

/** Route the Baithak instruments through one audio context and speaker output. */
export class BaithakAudio {
  private mix: Mix | null = null;
  private session: { audio: PlaybackSession; previousType: string } | null = null;

  get(): Mix | null {
    if (this.mix) return this.mix;
    const context = createBrowserAudioContext();
    if (!context) return null;
    const output = context.createGain();
    output.connect(context.destination);
    const audio = (navigator as Navigator & { audioSession?: PlaybackSession }).audioSession;
    if (audio) {
      const previousType = audio.type;
      audio.type = 'playback';
      this.session = { audio, previousType };
    }
    return this.mix = { context, output };
  }

  resume() {
    const context = this.mix?.context;
    if (context && context.state !== 'running' && context.state !== 'closed') {
      void context.resume().catch(() => {});
    }
  }

  close() {
    const mix = this.mix;
    this.mix = null;
    if (mix) void mix.context.close().catch(() => {});
    if (this.session) {
      const { audio, previousType } = this.session;
      if (audio.type === 'playback') audio.type = previousType;
      this.session = null;
    }
  }
}
