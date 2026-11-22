import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    window.testAudioSources = [];
    window.stoppedAudioSources = new WeakSet();
    window.microphoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.microphoneRequests++;
      throw new DOMException('Denied by test', 'NotAllowedError');
    };
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.testAudioSources.push(this);
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.stoppedAudioSources.add(this);
      return stop.apply(this, args);
    };
  });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
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
  await page.getByRole('navigation').getByRole('link', { name: 'Tabla', exact: true }).click();
  await page.waitForURL('**/tabla');
  assert.equal(await page.getByLabel('Taal', { exact: true }).locator('option').count(), 38);
  assert.deepEqual(failures, []);
  console.log('Tabla and Tanpura concurrent playback and mobile layout verified.');
} finally {
  await browser.close();
}
