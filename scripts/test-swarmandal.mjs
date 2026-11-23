import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    window.swarmandalTestSources = [];
    window.swarmandalStartTimes = new WeakMap();
    window.stoppedSources = new WeakSet();
    let hidden = false;
    Object.defineProperties(document, {
      hidden: { get: () => hidden },
      visibilityState: { get: () => hidden ? 'hidden' : 'visible' },
    });
    window.setTestPageHidden = value => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
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
  const base = process.env.VIO_TEST_URL ?? 'http://localhost:3100';
  for (const alias of ['/taalmala.html', '/baithak', '/baithak.html', '/riyaz', '/riyaz.html']) {
    const response = await page.request.get(new URL(`${alias}?source=bookmark`, base).href, { maxRedirects: 0 });
    assert.equal(response.status(), 308);
    assert.equal(response.headers().location, '/taalmala?source=bookmark');
  }
  await page.goto(base);
  const taalmalaLink = page.getByRole('link', { name: 'Taalmala', exact: true });
  assert.equal(await taalmalaLink.getAttribute('href'), '/taalmala');
  await taalmalaLink.click();
  await page.waitForURL('**/taalmala');
  await page.getByRole('heading', { name: 'Taalmala', exact: true }).waitFor();
  assert.equal(await page.title(), 'Taalmala · VIO');
  const master = page.getByRole('region', { name: 'Master Sa', exact: true });
  for (const text of ['Fine tune', '0¢', 'A 440.0 Hz', 'Sa 261.6 Hz', 'Master Mix']) {
    assert.equal(await master.getByText(text, { exact: true }).count(), 1);
  }
  const columns = () => page.locator('.baithak-instruments').evaluate(el =>
    getComputedStyle(el).gridTemplateColumns.split(' ').length);
  const mixSound = page.getByRole('switch', { name: 'Mix sound' });
  const fineTune = page.getByRole('slider', { name: 'Fine tune', exact: true });
  async function verifyMasterLayout() {
    const [fineTuneBox, masterBox] = await Promise.all([fineTune.boundingBox(), mixSound.boundingBox()]);
    assert.ok(masterBox.x >= fineTuneBox.x + fineTuneBox.width, 'Mix switch is to the right of Fine tune');
    assert.ok(Math.abs((masterBox.y + masterBox.height / 2) - (fineTuneBox.y + fineTuneBox.height / 2)) < 2);
  }
  assert.equal(await columns(), 1);
  await verifyMasterLayout();
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await columns(), 2);
  await verifyMasterLayout();
  const strip = name => page.locator(`.baithak-strip[data-instrument="${name}"]`);
  assert.equal(await strip('Harmonium').count(), 0);
  const [tanpuraBox, tablaBox, swarmandalBox] = await Promise.all(
    ['Tanpura', 'Tabla', 'Swarmandal'].map(name => strip(name).boundingBox()));
  assert.equal(swarmandalBox.x, tanpuraBox.x);
  assert.ok(swarmandalBox.x < tablaBox.x && swarmandalBox.y >= tanpuraBox.y + tanpuraBox.height);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await taalmalaLink.getAttribute('aria-current'), 'page');
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
  await fineTune.fill('15');
  assert.equal(await master.getByText('+15¢', { exact: true }).count(), 1);
  assert.equal(await master.getByText('A 443.8 Hz', { exact: true }).count(), 1);
  const tanpuraSound = page.getByRole('switch', { name: 'Tanpura sound' });
  await mixSound.check();
  const player = page.locator('audio');
  await page.waitForFunction(() => {
    const audio = document.querySelector('audio');
    return audio?.srcObject instanceof MediaStream && !audio.paused && audio.currentTime > 0;
  }, null, { timeout: 5000 });
  const mediaTrack = await player.evaluateHandle(audio => audio.srcObject.getAudioTracks()[0]);
  await tabla.locator('[aria-current="step"]').waitFor();
  assert.doesNotMatch(await master.innerText(), /Teentaal|BPM|\/16/);
  await page.waitForFunction(() => window.swarmandalTestSources.some(source => source.loop));
  const streamAnalyser = await player.evaluateHandle(audio => {
    const { context } = window.swarmandalTestSources.find(source => source.loop);
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(audio.srcObject).connect(analyser);
    return analyser;
  });
  await page.waitForFunction(analyser => {
    const frames = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(frames);
    return frames.some(sample => Math.abs(sample) > .001);
  }, streamAnalyser);
  await streamAnalyser.dispose();

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
  const beforeHide = await page.evaluate(() => {
    const offset = window.swarmandalTestSources.length;
    window.setTestPageHidden(true);
    return offset;
  });
  for (const name of ['Mix', 'Tanpura', 'Tabla', 'Swarmandal']) {
    await page.getByRole('switch', { name: `${name} sound` }).waitFor();
    assert.equal(await page.getByRole('switch', { name: `${name} sound` }).isChecked(), true,
      `${name} should stay on when the page is hidden`);
  }
  await page.waitForFunction(offset => {
    const [drone] = window.swarmandalTestSources.filter(source => source.loop);
    const newSources = window.swarmandalTestSources.slice(offset);
    return drone?.context.state === 'running' && !window.stoppedSources.has(drone) &&
      newSources.filter(source => !source.loop && source.detune.value === 0).length >= 32 &&
      newSources.some(source => !source.loop && source.detune.value === 15);
  }, beforeHide);
  await page.evaluate(async () => {
    const drone = window.swarmandalTestSources.find(source => source.loop);
    document.querySelector('audio').pause();
    await drone.context.suspend();
    window.setTestPageHidden(false);
  });
  await page.waitForFunction(() => window.swarmandalTestSources.find(source => source.loop)?.context.state === 'running');
  await page.waitForFunction(() => document.querySelector('audio')?.paused === false);
  await page.getByRole('switch', { name: 'Swarmandal sound' }).uncheck();
  await page.waitForFunction(() =>
    window.swarmandalTestSources.some(source => !source.loop && source.detune.value === 0 && window.stoppedSources.has(source)) &&
    window.swarmandalTestSources.some(source => source.loop && !window.stoppedSources.has(source) && source.context.state === 'running'));
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await verifyMasterLayout();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${width}px`);
  }
  await mixSound.uncheck();
  await page.waitForFunction(() => window.swarmandalTestSources.every(source => source.context.state === 'closed'));
  assert.equal(await player.count(), 0);
  assert.equal(await mediaTrack.evaluate(track => track.readyState), 'ended');
  await mediaTrack.dispose();
  assert.equal(await tanpuraSound.isChecked(), false);
  await mixSound.check();
  assert.equal(await tanpuraSound.isChecked(), true);
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
  console.log('Swarmandal left-column layout, tuning, playback, mix transport, and independent stop verified.');
} finally {
  await browser.close();
}
