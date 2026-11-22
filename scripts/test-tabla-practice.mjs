import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const base = process.env.VIO_TEST_URL ?? 'http://localhost:3100';
const layas = [['½×', .5], ['1×', 1], ['2×', 2], ['3×', 3], ['4×', 4]];

async function verifyPractice(route, durations) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  try {
    await page.addInitScript(() => {
      const start = AudioBufferSourceNode.prototype.start;
      window.tablaTimes = [];
      AudioBufferSourceNode.prototype.start = function (when, ...args) {
        if (!this.loop) {
          if (!window.tablaTimes.length) window.firstTablaStart = performance.now();
          window.tablaTimes.push(when);
        }
        return start.call(this, when, ...args);
      };
    });

    await page.goto(new URL(route, base).href);
    const tabla = page.getByRole('region', { name: 'Tabla', exact: true });
    const inMix = route === '/taalmala';
    const power = page.getByRole('switch', { name: 'Tabla sound', exact: true });
    const tanpura = page.getByRole('switch', { name: 'Tanpura sound', exact: true });
    const laya = tabla.getByLabel(inMix ? 'Laya' : 'Layakari', { exact: true });
    await laya.selectOption('3');
    await tabla.getByRole('slider', { name: /Tempo/ }).fill('120');
    const timer = tabla.getByRole('checkbox', { name: 'Timed practice' });
    const delay = tabla.getByRole('spinbutton', { name: 'Start delay (min)', exact: true });
    await delay.fill('0.05');
    await timer.check();
    assert.equal(await laya.isDisabled(), true);
    assert.equal(await delay.inputValue(), '0.05');
    const [volumeBox, delayBox, timerBox] = await Promise.all([
      tabla.getByRole('slider', { name: /Tabla volume/ }).boundingBox(),
      delay.boundingBox(),
      timer.boundingBox(),
    ]);
    assert.ok(volumeBox.y < delayBox.y && delayBox.y < timerBox.y);

    const fields = layas.map(([mark]) => tabla.getByRole('spinbutton', { name: `${mark} minutes`, exact: true }));
    for (const [index, minutes] of [10, 2, 6, 4, 8].entries()) await fields[index].fill(String(minutes));
    assert.equal(await tabla.getByText('Total 30 min', { exact: false }).count(), 1);

    for (const [index, minutes] of durations.entries()) await fields[index].fill(String(minutes));
    if (inMix) {
      await tanpura.check();
      await page.getByText(/Raw MP3/).waitFor();
    }
    const armedAt = await page.evaluate(() => performance.now());
    if (inMix) {
      await power.check();
    } else {
      await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).click();
    }

    const readout = tabla.locator('.tabla-practice-readout');
    await readout.getByText(/^Tabla starts in /).waitFor();
    assert.equal(await page.evaluate(() => window.tablaTimes.length), 0);
    assert.equal(await tabla.locator('.tabla-beats [aria-current="step"]').count(), 0);
    await readout.getByText('Now playing ½× · 60 BPM', { exact: true }).waitFor();
    await page.waitForFunction(() => window.tablaTimes.length > 0);
    assert.ok(await page.evaluate(armed => window.firstTablaStart - armed >= 2900, armedAt));
    assert.equal(await fields[0].isDisabled(), true);
    await readout.getByText(/^Laya \d+:\d\d left$/).waitFor();
    await readout.getByText(/^Total \d+:\d\d left$/).waitFor();
    assert.equal(await tabla.locator('.tabla-practice-stages [aria-current="step"] input').getAttribute('aria-label'), '½× minutes');

    let elapsed = 0;
    const stages = [];
    for (const [index, [mark, rate]] of layas.entries()) {
      const seconds = durations[index] * 60;
      if (!seconds) continue;
      await readout.getByText(`Now playing ${mark} · ${120 * rate} BPM`, { exact: true }).waitFor({ timeout: 15000 });
      await laya.locator(`option[value="${rate}"]:checked`).waitFor({ state: 'attached' });
      stages.push({ rate, start: elapsed, end: elapsed + seconds });
      elapsed += seconds;
    }

    await tabla.getByText('Practice complete', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await readout.count(), 0);
    if (inMix) {
      assert.equal(await power.isChecked(), false);
      assert.equal(await tanpura.isChecked(), true);
    } else {
      assert.equal(await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).isEnabled(), true);
    }
    const times = await page.evaluate(() => window.tablaTimes.map(at => at - window.tablaTimes[0]));
    assert.ok(times.at(-1) < elapsed + .02 && times.at(-1) >= elapsed - .35);
    for (const stage of stages) {
      const within = times.filter(time => time >= stage.start + 1.1 && time <= stage.end - .2);
      const expected = .5 / stage.rate;
      assert.ok(within.length >= 3, `${route} should play several beats at ${stage.rate}×`);
      assert.ok(within.slice(1).every((at, index) => Math.abs(at - within[index] - expected) < .005),
        `${route} actual audio scheduling must follow ${stage.rate}×`);
    }
    await timer.uncheck();
    assert.equal(await laya.inputValue(), '3', 'manual laya is restored after turning timed practice off');
    if (!inMix) {
      await page.evaluate(() => { window.tablaTimes = []; });
      await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).click();
      await readout.getByText(/^Tabla starts in /).waitFor();
      await tabla.getByRole('button', { name: 'Cancel Start', exact: true }).click();
      assert.equal(await readout.count(), 0);
      assert.equal(await page.evaluate(() => window.tablaTimes.length), 0);
      await delay.fill('0.02');
      await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).click();
      await readout.getByText(/^Tabla starts in /).waitFor();
      await tabla.locator('.tabla-beats [aria-current="step"]').first().waitFor();
      await tabla.getByRole('button', { name: 'Stop Tabla', exact: true }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log(`${route}: silent start delay, ${stages.map(stage => stage.rate + '×').join(' → ')} audio, and end after ${elapsed}s of playback verified.`);
  } finally {
    await page.close();
  }
}

async function verifyInvalidMixTimer() {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  try {
    await page.goto(new URL('/taalmala', base).href);
    const tabla = page.getByRole('region', { name: 'Tabla', exact: true });
    await tabla.getByRole('checkbox', { name: 'Timed practice' }).check();
    for (const [mark] of layas) await tabla.getByRole('spinbutton', { name: `${mark} minutes` }).fill('0');
    await page.getByRole('switch', { name: 'Mix sound', exact: true }).check();
    await tabla.getByRole('alert').filter({ hasText: /Set at least one laya/ }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Tabla sound', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('switch', { name: 'Tanpura sound', exact: true }).isChecked(), true);
  } finally {
    await page.close();
  }
}

try {
  await Promise.all([
    verifyPractice('/taalmala', [.1, .15, .1, .1, .1]),
    verifyPractice('/tabla', [.1, .15, .1, 0, .1]),
    verifyInvalidMixTimer(),
  ]);
} finally {
  await browser.close();
}
