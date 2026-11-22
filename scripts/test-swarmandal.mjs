import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const oscillatorStart = OscillatorNode.prototype.start;
    window.harmoniumTestSources = [];
    OscillatorNode.prototype.start = function (...args) {
      window.harmoniumTestSources.push(this);
      return oscillatorStart.apply(this, args);
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    window.swarmandalTestSources = [];
    window.swarmandalStartTimes = new WeakMap();
    window.stoppedSources = new WeakSet();
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.swarmandalTestSources.push(this);
      window.swarmandalStartTimes.set(this, args[0]);
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.stoppedSources.add(this);
      return stop.apply(this, args);
    };
  });
  await page.goto(new URL('/baithak', process.env.VIO_TEST_URL ?? 'http://localhost:3100').href);
  await page.getByRole('heading', { name: 'Taalmala', exact: true }).waitFor();
  assert.equal(await page.title(), 'Taalmala · VIO');
  const columns = () => page.locator('.baithak-instruments').evaluate(el =>
    getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(await columns(), 1);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await columns(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('link', { name: 'Taalmala', exact: true }).getAttribute('aria-current'), 'page');
  const swarmandal = page.getByRole('region', { name: 'Swarmandal', exact: true });
  await swarmandal.waitFor({ timeout: 5000 });
  const tabla = page.getByRole('region', { name: 'Tabla', exact: true });
  await page.getByRole('group', { name: 'Sa / Key' }).getByRole('button', { name: 'D', exact: true }).click();
  const mixRaag = swarmandal.getByLabel('Raag', { exact: true });
  const catalog = select => select.locator('option').evaluateAll(options =>
    options.map(option => [option.value, option.textContent, option.parentElement.label]));
  const mixRagas = await catalog(mixRaag);
  assert.equal(mixRagas.length, 32);
  assert.equal(new Set(mixRagas.map(([id]) => id)).size, 32);
  await mixRaag.selectOption('darbari_kanada');
  assert.equal(await swarmandal.getByRole('slider', { name: 'Sweep Every' }).inputValue(), '9');
  assert.equal(await swarmandal.getByRole('slider', { name: 'Volume' }).inputValue(), '32');
  assert.equal(await swarmandal.locator('input, select, button').count(), 4);
  assert.equal(await swarmandal.locator('[data-string]').count(), 0);
  await swarmandal.getByRole('slider', { name: 'Sweep Every' }).fill('2');
  await swarmandal.getByRole('slider', { name: 'Speed' }).fill('25');
  await page.getByRole('slider', { name: 'Fine tune' }).fill('15');
  const mixSound = page.getByRole('switch', { name: 'Mix sound' });
  const harmoniumSound = page.getByRole('switch', { name: 'Harmonium sound' });
  await mixSound.check();
  await harmoniumSound.check();
  await page.waitForFunction(() =>
    window.harmoniumTestSources.some(source => source.context.state === 'running'));
  await tabla.locator('[aria-current="step"]').waitFor();
  const transport = page.locator('.baithak-transport');
  assert.match(await transport.innerText(), /Teentaal[\s\S]*33 BPM/);
  assert.match(await transport.locator('output').innerText(), /^\d+\/16$/);
  await page.waitForFunction(() => window.swarmandalTestSources.some(source => source.loop));

  const activeContexts = () => page.evaluate(() =>
    new Set(window.swarmandalTestSources.filter(source => source.context.state === 'running')
      .map(source => source.context)).size);
  assert.equal(await activeContexts(), 1);
  const stringSpacing = await page.evaluate(() => {
    const strings = window.swarmandalTestSources.filter(source => !source.loop && source.detune.value === 0);
    return window.swarmandalStartTimes.get(strings[1]) - window.swarmandalStartTimes.get(strings[0]);
  });
  assert.ok(Math.abs(stringSpacing - .04) < .0001, '25 strings per second schedules notes 40ms apart');
  assert.equal(await page.evaluate(() => window.swarmandalTestSources.some(source => source.loop && source.detune.value === 15)), true);
  assert.equal(await page.evaluate(() => window.swarmandalTestSources.some(source => !source.loop && source.detune.value === 15)), true);
  await page.waitForFunction(() =>
    window.swarmandalTestSources.filter(source => !source.loop && source.detune.value === 0).length >= 64);
  await page.getByRole('switch', { name: 'Swarmandal sound' }).uncheck();
  await page.waitForFunction(() =>
    window.swarmandalTestSources.some(source => !source.loop && source.detune.value === 0 && window.stoppedSources.has(source)) &&
    window.swarmandalTestSources.some(source => source.loop && !window.stoppedSources.has(source) && source.context.state === 'running'));
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${width}px`);
  }
  await mixSound.uncheck();
  await page.waitForFunction(() => window.swarmandalTestSources.every(source => source.context.state === 'closed'));
  assert.equal(await harmoniumSound.isChecked(), false);
  await page.waitForFunction(() => window.harmoniumTestSources.every(source => source.context.state === 'closed'));
  await mixSound.check();
  assert.equal(await harmoniumSound.isChecked(), true);
  assert.equal(await page.getByRole('switch', { name: 'Swarmandal sound' }).isChecked(), false);
  await mixSound.uncheck();
  const routes = { tanpura: 'Tanpura Drone', tabla: 'Tabla', swarmandal: 'Swarmandal' };
  for (const [route, instrument] of Object.entries(routes)) {
    await page.getByRole('navigation').getByRole('link', { name: instrument === 'Tanpura Drone' ? 'Tanpura' : instrument, exact: true }).click();
    await page.waitForURL(`**/${route}`);
    await page.getByRole('region', { name: instrument, exact: true }).waitFor();
    if (route === 'swarmandal') {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const standaloneRaag = page.getByLabel('Raga', { exact: true });
      assert.deepEqual(await catalog(standaloneRaag), mixRagas);
      await standaloneRaag.selectOption('malkauns');
      assert.equal(await page.locator('[data-string]').count(), 32);
      assert.match(await page.locator('[data-string="1"]').getAttribute('aria-label'), /, ga$/);
      await page.getByRole('combobox', { name: 'Root (Sa)' }).selectOption('D');
      await page.getByRole('combobox', { name: 'Sound' }).selectOption('pad');
      await page.getByRole('slider', { name: 'Ring' }).fill('2');
      await page.getByRole('slider', { name: 'Room' }).fill('0.5');
      const first = await page.locator('[data-string="0"]').boundingBox();
      const last = await page.locator('[data-string="31"]').boundingBox();
      assert.ok(first && last && Math.abs(first.y - last.y) < 1, '32 strings share one row');
      await page.locator('[data-string="0"]').scrollIntoViewIfNeeded();
      const left = await page.locator('[data-string="0"]').boundingBox();
      const right = await page.locator('[data-string="31"]').boundingBox();
      assert.ok(left && right);
      const beforeDrag = await page.evaluate(() => window.swarmandalTestSources.length);
      await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
      await page.mouse.down();
      await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
      await page.mouse.up();
      await page.waitForFunction(count => window.swarmandalTestSources.length === count + 32, beforeDrag);
      assert.equal(await page.evaluate(() => window.swarmandalTestSources.at(-1).buffer.duration), 2);

      await page.getByRole('slider', { name: 'Speed' }).fill('30');
      await page.getByRole('slider', { name: 'Every' }).fill('1');
      await page.getByRole('switch', { name: 'Repeat' }).check();
      await page.getByRole('button', { name: 'Pakad', exact: true }).click();
      await page.getByText(/2 sweeps/).waitFor();
      await page.getByRole('button', { name: 'Stop Swarmandal' }).click();
    }
    for (const other of Object.values(routes).filter(name => name !== instrument)) {
      assert.equal(await page.getByRole('region', { name: other, exact: true }).count(), 0);
    }
  }
  console.log('Swarmandal tuning, manual and timed playback, master tuning, Harmonium, mix transport, and independent stop verified.');
} finally {
  await browser.close();
}
