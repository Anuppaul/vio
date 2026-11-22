import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await page.addInitScript(() => {
    const fetchAudio = window.fetch;
    const readAudio = Response.prototype.arrayBuffer;
    const decodeAudio = AudioContext.prototype.decodeAudioData;
    const sourcesByResponse = new WeakMap();
    const sourcesByBytes = new WeakMap();
    const sourcesByBuffer = new WeakMap();
    window.fetch = async function (input, options) {
      const response = await fetchAudio.call(this, input, options);
      if (typeof input === 'string' && input.startsWith('/assets/tabla/')) {
        sourcesByResponse.set(response, input.split('/').at(-1));
      }
      return response;
    };
    Response.prototype.arrayBuffer = async function () {
      const bytes = await readAudio.call(this);
      const source = sourcesByResponse.get(this);
      if (source) sourcesByBytes.set(bytes, source);
      return bytes;
    };
    AudioContext.prototype.decodeAudioData = async function (bytes, ...args) {
      const source = sourcesByBytes.get(bytes);
      const buffer = await decodeAudio.call(this, bytes, ...args);
      if (source) sourcesByBuffer.set(buffer, source);
      return buffer;
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    const connect = AudioNode.prototype.connect;
    const outputs = new WeakMap();
    const meters = new WeakMap();
    AudioNode.prototype.connect = function (destination, ...args) {
      if (destination instanceof AudioNode) outputs.set(this, destination);
      return connect.call(this, destination, ...args);
    };
    window.testAudioSources = [];
    window.playedTablaTakes = [];
    window.stoppedAudioSources = new WeakSet();
    window.microphoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.microphoneRequests++;
      throw new DOMException('Denied by test', 'NotAllowedError');
    };
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.testAudioSources.push(this);
      const take = sourcesByBuffer.get(this.buffer);
      if (take && this.context instanceof AudioContext) {
        window.playedTablaTakes.push(take);
        const gain = outputs.get(this);
        const limiter = outputs.get(gain);
        const peakGuard = outputs.get(limiter);
        window.tablaGain = gain.gain;
        window.tablaLimiter = limiter;
        window.tablaPeakGuard = peakGuard;
        if (peakGuard instanceof WaveShaperNode && !meters.has(peakGuard)) {
          const meter = this.context.createAnalyser();
          connect.call(peakGuard, meter);
          meters.set(peakGuard, meter);
        }
        window.tablaMeter = meters.get(peakGuard);
      }
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.stoppedAudioSources.add(this);
      return stop.apply(this, args);
    };
  });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  async function verifyRepeatedDha(laya, start, stop, defaultVolume) {
    await page.getByLabel('Taal', { exact: true }).selectOption('teentaal');
    await page.getByRole('slider', { name: /Tempo/ }).fill('240');
    await laya.selectOption('2');
    await page.evaluate(() => { window.playedTablaTakes = []; });
    await start();
    await page.waitForFunction(() =>
      window.playedTablaTakes.filter(take => /^Dha(?:\d+)?\.wav$/.test(take)).length >= 12);
    const volume = page.getByRole('slider', { name: /Tabla volume/ });
    assert.equal(await volume.inputValue(), String(defaultVolume));
    assert.ok(Math.abs(await page.evaluate(() => window.tablaGain.value) - defaultVolume * .033) < .001);
    const boostDb = await page.evaluate(async previousGain => {
      const limiter = window.tablaLimiter;
      const peakCurve = window.tablaPeakGuard.curve;
      const currentGain = window.tablaGain.value;
      const sampleRate = limiter.context.sampleRate;
      const response = await fetch('/assets/tabla/Dha.wav');
      const buffer = await limiter.context.decodeAudioData(await response.arrayBuffer());
      async function power(level) {
        const render = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, sampleRate);
        const source = render.createBufferSource();
        source.buffer = buffer;
        const gain = render.createGain();
        gain.gain.value = level;
        const compressor = render.createDynamicsCompressor();
        for (const parameter of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
          compressor[parameter].value = limiter[parameter].value;
        }
        const peakGuard = render.createWaveShaper();
        peakGuard.curve = peakCurve;
        source.connect(gain).connect(compressor).connect(peakGuard).connect(render.destination);
        source.start();
        const output = await render.startRendering();
        return output.getChannelData(0).reduce((sum, value) => sum + value ** 2, 0);
      }
      const [baseline, boosted] = await Promise.all([power(previousGain), power(currentGain)]);
      return 10 * Math.log10(boosted / baseline);
    }, defaultVolume * .0225);
    assert.ok(boostDb >= 1.5, `Dha output should gain at least 1.5 dB at the default volume, got ${boostDb.toFixed(2)} dB`);
    console.log(`Dha at ${defaultVolume}% gained ${boostDb.toFixed(2)} dB after the limiter.`);
    for (const [percent, gain] of [['0', 0], ['100', 3.3]]) {
      await volume.fill(percent);
      await page.waitForFunction(target => Math.abs(window.tablaGain.value - target) < .001, gain);
    }
    const peak = await page.evaluate(async () => {
      const meter = window.tablaMeter;
      const samples = new Float32Array(meter.fftSize);
      const end = meter.context.currentTime + 1;
      let peak = 0;
      while (meter.context.currentTime < end) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      return peak;
    });
    assert.ok(peak > .05 && peak < 1, `fast Tabla at full volume should produce audible, unclipped output, got peak ${peak}`);
    await stop();
    const dha = await page.evaluate(() =>
      window.playedTablaTakes.filter(take => /^Dha(?:\d+)?\.wav$/.test(take)));
    assert.ok(new Set(dha).size >= 4, 'repeated Dha uses multiple Naad recordings');
    assert.ok(dha.slice(1).every((take, index) => take !== dha[index]),
      'a recording cannot repeat on successive occurrences of the same bol');
  }
  await page.goto(new URL('/baithak', process.env.VIO_TEST_URL ?? 'http://localhost:3100').href);
  const tanpuraSound = page.getByRole('switch', { name: 'Tanpura sound' });
  const tablaSound = page.getByRole('switch', { name: 'Tabla sound' });
  const tabla = page.getByRole('region', { name: 'Tabla', exact: true });
  await tabla.waitFor({ timeout: 5000 });
  assert.equal(await tabla.getByRole('checkbox', { name: 'Auto Intelligence' }).count(), 0);
  assert.equal(await tabla.getByLabel('Laya', { exact: true }).isEnabled(), true);
  assert.equal(await tabla.getByRole('slider', { name: /Tempo/ }).isEnabled(), true);
  const taal = tabla.getByLabel('Taal', { exact: true });
  const options = await taal.locator('option').evaluateAll(nodes =>
    nodes.map(option => ({ id: option.value, beats: Number(option.textContent.match(/(\d+) beats$/)?.[1]) })));
  assert.equal(options.length, 38);
  assert.equal(new Set(options.map(option => option.id)).size, 38);
  for (const { id, beats } of options) {
    await taal.selectOption(id);
    assert.equal(await tabla.locator('[data-bol]').count(), beats, id);
  }
  await taal.selectOption('chautaal');
  const strings = page.getByLabel('Tanpura strings');
  assert.deepEqual(await strings.locator('option').evaluateAll(items => items.map(item => item.value)), ['sa-pa', 'sa-ma']);
  await strings.selectOption('sa-ma');
  await tanpuraSound.check();
  await page.getByText(/SA MA .*Raw MP3/).waitFor();
  const originalLoopDuration = await page.evaluate(() => {
    const source = window.testAudioSources.find(source => source.loop);
    return source.loopEnd - source.loopStart;
  });
  const speed = page.getByRole('slider', { name: 'Tanpura speed' });
  await speed.fill('150');
  await page.waitForFunction(duration => window.testAudioSources.some(source =>
    source.loop && source.playbackRate.value === 1 &&
    Math.abs((source.loopEnd - source.loopStart) / duration - 2 / 3) < .025),
  originalLoopDuration, { timeout: 5000 });
  await page.getByText(/SA MA .*Recorded audio/).waitFor();
  await tablaSound.check();
  assert.equal(await tablaSound.isChecked(), true);
  await tabla.locator('[aria-current="step"]').waitFor();
  assert.equal(await tanpuraSound.isChecked(), true);
  await page.waitForFunction(() => {
    const sources = window.testAudioSources;
    return [true, false].every(loop =>
      sources.some(source => source.loop === loop && source.context.state === 'running'));
  });
  await taal.selectOption('dadra');
  assert.equal(await tabla.locator('[data-bol]').count(), 6);
  await tablaSound.uncheck();
  assert.equal(await page.evaluate(() => window.microphoneRequests), 0);
  assert.equal(await tanpuraSound.isChecked(), true);
  assert.equal(await tabla.locator('[aria-current="step"]').count(), 0);
  await page.waitForFunction(() =>
    window.testAudioSources.some(source => !source.loop && window.stoppedAudioSources.has(source)) &&
    window.testAudioSources.some(source => source.loop && !window.stoppedAudioSources.has(source) && source.context.state === 'running'));
  await page.getByRole('group', { name: 'Sa / Key' }).getByRole('button', { name: 'D', exact: true }).click();
  await tabla.getByText('Sa · D', { exact: true }).waitFor();
  await tablaSound.check();
  await page.waitForFunction(() => window.testAudioSources.some(source =>
    !source.loop && Math.abs(source.playbackRate.value - 2 ** (2 / 12)) < .0001));
  await tanpuraSound.uncheck();
  assert.equal(await tablaSound.isChecked(), true);
  await tablaSound.uncheck();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await verifyRepeatedDha(tabla.getByLabel('Laya', { exact: true }),
    () => tablaSound.check(), () => tablaSound.uncheck(), 38);
  await page.getByRole('navigation').getByRole('link', { name: 'Tabla', exact: true }).click();
  await page.waitForURL('**/tabla');
  assert.equal(await page.getByLabel('Taal', { exact: true }).locator('option').count(), 38);
  await verifyRepeatedDha(page.getByLabel('Layakari', { exact: true }),
    () => page.getByRole('button', { name: 'Play Tabla', exact: true }).click(),
    () => page.getByRole('button', { name: 'Stop Tabla', exact: true }).click(), 65);
  assert.deepEqual(failures, []);
  console.log('Tabla boost, mute, fast playback peaks, and rotating Dha takes verified in Taalmala and Tabla.');
} finally {
  await browser.close();
}
