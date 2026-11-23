import { createBrowserAudioContext } from './browser-audio';

type MediaOutput = { element: HTMLAudioElement; destination: MediaStreamAudioDestinationNode };
type Mix = { context: AudioContext; output: GainNode; media?: MediaOutput };
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
    const mix: Mix = { context, output };
    this.mix = mix;
    const audio = (navigator as Navigator & { audioSession?: PlaybackSession }).audioSession;
    if (audio) {
      const previousType = audio.type;
      audio.type = 'playback';
      this.session = { audio, previousType };
    }
    this.connectMedia(mix);
    return mix;
  }

  private connectMedia(mix: Mix) {
    const { context, output } = mix;
    const element = document.createElement('audio');
    if (!('srcObject' in element) || typeof context.createMediaStreamDestination !== 'function') return;

    // Let the browser handle the actual mix as audio playback. Keep direct
    // Web Audio output until the element starts, or if it cannot play.
    const destination = context.createMediaStreamDestination();
    const media: MediaOutput = { element, destination };
    mix.media = media;
    element.hidden = true;
    element.srcObject = destination.stream;
    document.body.append(element);

    const fallback = () => {
      if (this.mix !== mix || mix.media !== media) return;
      mix.media = undefined;
      output.disconnect();
      output.connect(context.destination);
      this.releaseMedia(media);
    };
    element.onerror = fallback;
    void element.play().then(() => {
      if (this.mix !== mix || mix.media !== media) return;
      output.disconnect();
      output.connect(destination);
    }, fallback);
  }

  private releaseMedia({ element, destination }: MediaOutput) {
    element.onerror = null;
    element.pause();
    element.srcObject = null;
    element.remove();
    for (const track of destination.stream.getTracks()) track.stop();
  }

  resume() {
    const mix = this.mix;
    if (!mix || mix.context.state === 'closed') return;
    const { context, media } = mix;
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
    }
    if (media?.element.paused) void media.element.play().catch(() => {});
  }

  close() {
    const mix = this.mix;
    this.mix = null;
    if (mix?.media) this.releaseMedia(mix.media);
    if (mix) void mix.context.close().catch(() => {});
    if (this.session) {
      const { audio, previousType } = this.session;
      if (audio.type === 'playback') audio.type = previousType;
      this.session = null;
    }
  }
}
