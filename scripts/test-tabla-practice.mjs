import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const base = process.env.VIO_TEST_URL ?? 'http://localhost:3100';
const layas = [['½×', .5], ['1×', 1], ['2×', 2], ['3×', 3], ['4×', 4]];

async function verifyPractice(route, durations) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
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
    const digits = page.getByRole('timer', { name: 'Tabla countdown' });
    const total = page.getByRole('timer', { name: 'Total session remaining' });
    const practiceSeconds = Math.round(durations.reduce((sum, minutes) => sum + minutes * 60, 0));
    await digits.waitFor({ timeout: 5000 });
    const progress = digits.locator('.tabla-countdown-progress');
    assert.equal(await progress.evaluate(el => getComputedStyle(el).strokeLinecap), 'round');
    assert.equal(await digits.locator('.tabla-countdown-track').evaluate(el => getComputedStyle(el).stroke), 'rgb(237, 239, 243)');
    await total.waitFor({ timeout: 5000 });
    assert.match(await digits.innerText(), /^00:0[1-3]$/);
    assert.ok(Number((await total.innerText()).split(':')[1]) > practiceSeconds);
    await page.getByText('Start delay', { exact: true }).waitFor();
    await page.getByText('Next · Tabla starts at ½× laya · 00:06', { exact: true }).waitFor();
    assert.equal(await digits.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await digits.evaluate(el => getComputedStyle(el).color), 'rgb(198, 46, 77)');
    await readout.getByText(/^Tabla starts in /).waitFor();
    assert.equal(await page.evaluate(() => window.tablaTimes.length), 0);
    assert.equal(await tabla.locator('.tabla-beats [aria-current="step"]').count(), 0);
    await readout.getByText('Now playing ½× · 60 BPM', { exact: true }).waitFor();
    await page.waitForFunction(() => window.tablaTimes.length > 0);
    assert.ok(await page.evaluate(armed => window.firstTablaStart - armed >= 2900, armedAt));
    assert.equal(await fields[0].isDisabled(), true);
    await readout.getByText(/^Laya \d+:\d\d left$/).waitFor();
    await readout.getByText(/^Total \d+:\d\d left$/).waitFor();
    assert.match(await digits.innerText(), /^00:0[4-6]$/);
    assert.ok(Number((await total.innerText()).split(':')[1]) > 10);
    await page.getByText('Now playing · ½× laya', { exact: true }).waitFor();
    await page.getByText('Next · 1× laya · 00:09', { exact: true }).waitFor();
    const largeSize = (await digits.boundingBox()).width;
    assert.ok(largeSize > 90);
    const fill = await progress.evaluate(el => 100 - parseFloat(getComputedStyle(el).strokeDashoffset));
    assert.ok(fill >= 60 && fill <= 100, 'The laya refills its own countdown after the delay');
    assert.equal(await digits.evaluate(el => getComputedStyle(el.parentElement).backgroundColor), 'rgba(255, 255, 255, 0.38)');
    const totalBox = await total.boundingBox();
    const timerCard = page.locator('.tabla-countdown-corner');
    const expandedCard = await page.locator('.tabla-countdown-stage').boundingBox();
    assert.ok(totalBox.y >= expandedCard.y && totalBox.y < expandedCard.y + 30 &&
      totalBox.x + totalBox.width >= expandedCard.x + expandedCard.width - 20);
    assert.equal(await digits.evaluate(el => getComputedStyle(el).color), 'rgb(198, 46, 77)');
    assert.equal(await total.evaluate(el => getComputedStyle(el).color), 'rgb(169, 75, 11)');
    assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[role="timer"]')), null);
    await page.mouse.move(75, 75);
    const cornerTimer = () => {
      const timer = document.querySelector('[role="timer"][aria-label="Tabla countdown"]');
      const box = timer?.getBoundingClientRect();
      return box && box.top < 150 && box.right >= innerWidth - 40 && box.width <= 36;
    };
    await page.waitForFunction(cornerTimer, null, { polling: 50, timeout: 1500 });
    const [stageBox, cardBox, compactTotal] = await Promise.all([digits.boundingBox(), timerCard.boundingBox(), total.boundingBox()]);
    assert.ok(compactTotal.y >= cardBox.y && stageBox.y > compactTotal.y + compactTotal.height && stageBox.y + stageBox.height < cardBox.y + cardBox.height);
    assert.match(await timerCard.evaluate(el => getComputedStyle(el).backgroundImage), /^linear-gradient/);
    await page.waitForTimeout(1100);
    await page.mouse.wheel(0, 150);
    const scrollAt = Date.now();
    await page.waitForTimeout(1100);
    assert.ok(await page.evaluate(cornerTimer), 'Scrolling resets the inactivity delay');
    await page.waitForFunction(() => {
      const timer = document.querySelector('[role="timer"][aria-label="Tabla countdown"]');
      return timer && timer.getBoundingClientRect().width > 90;
    }, null, { polling: 50, timeout: 3000 });
    assert.ok(Date.now() - scrollAt >= 1900, 'Timer grows after two seconds of inactivity');
    assert.equal(await tabla.locator('.tabla-practice-stages [aria-current="step"] input').getAttribute('aria-label'), '½× minutes');

    let elapsed = 0;
    const stages = [];
    for (const [index, [mark, rate]] of layas.entries()) {
      const seconds = durations[index] * 60;
      if (!seconds) continue;
      await readout.getByText(`Now playing ${mark} · ${120 * rate} BPM`, { exact: true }).waitFor({ timeout: 15000 });
      await page.getByText(`Now playing · ${mark} laya`, { exact: true }).waitFor();
      const next = durations.findIndex((minutes, nextIndex) => nextIndex > index && minutes > 0);
      await page.getByText(next === -1 ? 'Next · Practice ends' :
        `Next · ${layas[next][0]} laya · 00:${String(Math.round(durations[next] * 60)).padStart(2, '0')}`, { exact: true }).waitFor();
      await laya.locator(`option[value="${rate}"]:checked`).waitFor({ state: 'attached' });
      stages.push({ rate, start: elapsed, end: elapsed + seconds });
      elapsed += seconds;
    }

    await tabla.getByText('Practice complete', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await readout.count(), 0);
    assert.equal(await digits.count(), 0);
    assert.equal(await total.count(), 0);
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
    if (inMix) {
      const master = page.getByRole('switch', { name: 'Mix sound', exact: true });
      await master.uncheck();
      await page.evaluate(() => { window.tablaTimes = []; });
      await master.check();
      assert.equal(await power.isChecked(), true, 'Master Mix restarts Tabla after timed practice completes');
      await readout.getByText(/^Tabla starts in /).waitFor();
      await digits.waitFor();
      await page.waitForFunction(() => window.tablaTimes.length > 0, null, { timeout: 6000 });
      await master.uncheck();
    }
    await timer.uncheck();
    assert.equal(await laya.inputValue(), '3', 'manual laya is restored after turning timed practice off');
    if (!inMix) {
      await page.evaluate(() => { window.tablaTimes = []; });
      await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).click();
      await readout.getByText(/^Tabla starts in /).waitFor();
      await page.getByText('Next · Tabla starts', { exact: true }).waitFor();
      assert.equal(await total.count(), 0);
      await tabla.getByRole('button', { name: 'Cancel Start', exact: true }).click();
      await digits.waitFor({ state: 'hidden' });
      assert.equal(await readout.count(), 0);
      assert.equal(await page.evaluate(() => window.tablaTimes.length), 0);
      await delay.fill('0.02');
      await tabla.getByRole('button', { name: 'Play Tabla', exact: true }).click();
      await readout.getByText(/^Tabla starts in /).waitFor();
      await tabla.locator('.tabla-beats [aria-current="step"]').first().waitFor();
      await digits.waitFor({ state: 'hidden' });
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
