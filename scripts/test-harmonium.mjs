import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const start = OscillatorNode.prototype.start;
    const stop = OscillatorNode.prototype.stop;
    window.harmoniumVoices = [];
    window.harmoniumReleases = [];
    OscillatorNode.prototype.start = function (...args) {
      window.harmoniumVoices.push(this);
      return start.apply(this, args);
    };
    OscillatorNode.prototype.stop = function (...args) {
      window.harmoniumReleases.push(this);
      return stop.apply(this, args);
    };
  });
  const base = process.env.VIO_TEST_URL ?? 'http://localhost:3100';
  await page.goto(new URL('/baithak', base).href);
  const instrument = page.getByRole('region', { name: 'Harmonium', exact: true });
  const modes = instrument.getByLabel('Harmonium mode').locator('option');
  const reeds = instrument.getByLabel('Reed register').locator('option');
  const drones = instrument.getByLabel('Drone notes').locator('option');
  assert.equal(await modes.count(), 2);
  assert.equal(await reeds.count(), 3);
  assert.equal(await drones.count(), 4);
  await instrument.getByLabel('Drone notes').selectOption('octave');
  await instrument.getByLabel('Reed register').selectOption('bass');
  const sound = page.getByRole('switch', { name: 'Harmonium sound' });
  await sound.check();
  await page.waitForFunction(() => window.harmoniumVoices.length === 3);
  assert.ok(await page.evaluate(() => window.harmoniumVoices[0].frequency.value < 132));
  await instrument.getByLabel('Harmonium mode').selectOption('keyboard');
  await page.waitForFunction(() => window.harmoniumReleases.length === 3);
  assert.equal(await instrument.locator('[data-harmonium-key]').count(), 37);
  await sound.uncheck();
  assert.equal(await instrument.getByRole('button', { name: 'Sa', exact: true }).isDisabled(), true);

  await page.getByRole('navigation').getByRole('link', { name: 'Harmonium', exact: true }).click();
  await page.waitForURL('**/harmonium');
  const keyboard = page.getByRole('group', { name: 'Harmonium keyboard' });
  assert.equal(await keyboard.locator('[data-harmonium-key]').count(), 37);
  await keyboard.getByRole('button', { name: 'Highest Sa', exact: true }).waitFor();
  const tonic = keyboard.getByRole('button', { name: 'Lower Sa', exact: true });
  await tonic.focus();
  const started = await page.evaluate(() => window.harmoniumVoices.length);
  const released = await page.evaluate(() => window.harmoniumReleases.length);
  await page.keyboard.down('a');
  await page.keyboard.down('d');
  await page.waitForFunction(count => window.harmoniumVoices.length === count + 2, started);
  assert.equal(await keyboard.locator('[aria-pressed="true"]').count(), 2);
  await page.keyboard.up('a');
  await page.keyboard.up('d');
  await page.waitForFunction(count => window.harmoniumReleases.length === count + 2, released);
  assert.equal(await keyboard.locator('[aria-pressed="true"]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Harmonium modes, reeds, drones and 37-key polyphonic keyboard verified.');
} finally {
  await browser.close();
}
