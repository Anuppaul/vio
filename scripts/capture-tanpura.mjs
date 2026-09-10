#!/usr/bin/env node

/**
 * Capture Spardha Tanpura audio with a real Chromium browser.
 *
 * Default: all 24 combinations, 60 seconds each, written to tanpura-captures/.
 * The script captures the site's rendered WebAudio/media output and also saves
 * any complete audio responses exposed by the site under original_network_audio/.
 *
 * Requirements (Ubuntu):
 *   sudo apt install -y ffmpeg
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *
 * Examples:
 *   node scripts/capture-tanpura.mjs --headed
 *   node scripts/capture-tanpura.mjs --seconds 120 --headed
 *   node scripts/capture-tanpura.mjs --only-pattern sa-pa --only-key C --seconds 120 --headed
 *   node scripts/capture-tanpura.mjs --output public/assets/tanpura --force --seconds 120 --headed
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PRIMARY_URL = 'https://www.spardhaschoolofmusic.com/tools/tanpura';
const FALLBACK_URL = 'https://music-tools.spardhaschoolofmusic.com/tanpura';
const KEYS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const PATTERNS = [
  { id: 'sa-pa', label: /SA\s*[-–—]?\s*PA/i },
  { id: 'sa-ma', label: /SA\s*[-–—]?\s*MA/i },
];

function parseArgs(argv) {
  const out = {
    seconds: 60,
    settle: 2.0,
    patternSettle: 3.0,
    output: 'tanpura-captures',
    headed: false,
    force: false,
    url: '',
    onlyKey: '',
    onlyPattern: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value after ${a}`);
      return argv[++i];
    };
    if (a === '--seconds') out.seconds = Number(next());
    else if (a === '--settle') out.settle = Number(next());
    else if (a === '--pattern-settle') out.patternSettle = Number(next());
    else if (a === '--output') out.output = next();
    else if (a === '--url') out.url = next();
    else if (a === '--only-key') out.onlyKey = next();
    else if (a === '--only-pattern') out.onlyPattern = next();
    else if (a === '--headed') out.headed = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log(`\nTanpura capture\n\n` +
        `  --seconds N           seconds per combination (default 60)\n` +
        `  --settle N            wait after key change (default 2.0)\n` +
        `  --pattern-settle N    wait after pattern change (default 3.0)\n` +
        `  --output DIR          output directory (default tanpura-captures)\n` +
        `  --only-pattern ID     sa-pa or sa-ma\n` +
        `  --only-key KEY        C, C#, D ... B\n` +
        `  --url URL             override source URL\n` +
        `  --headed              show Chromium\n` +
        `  --force               overwrite existing MP3 files\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.seconds) || out.seconds < 5) throw new Error('--seconds must be >= 5');
  if (out.onlyKey && !KEYS.includes(out.onlyKey)) throw new Error(`Invalid --only-key: ${out.onlyKey}`);
  if (out.onlyPattern && !PATTERNS.some(p => p.id === out.onlyPattern)) throw new Error(`Invalid --only-pattern: ${out.onlyPattern}`);
  return out;
}

function hasCommand(command) {
  const r = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function keySlug(key) { return key.replace('#', 's'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function extensionFor(contentType = '', url = '') {
  const pathname = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  const ext = path.extname(pathname).toLowerCase();
  if (['.mp3','.wav','.ogg','.oga','.m4a','.aac','.webm','.flac'].includes(ext)) return ext;
  const type = contentType.toLowerCase().split(';')[0].trim();
  return ({
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
    'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm',
    'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  })[type] || '.bin';
}

const CAPTURE_INIT = String.raw`
(() => {
  if (window.__VIO_TANPURA_CAPTURE__) return;
  window.__VIO_TANPURA_CAPTURE__ = true;

  const contextCaps = new WeakMap();
  const contexts = [];
  const mediaStreams = [];
  const mediaSeen = new WeakSet();

  function ensureContextCapture(ctx) {
    if (!ctx) return null;
    if (contextCaps.has(ctx)) return contextCaps.get(ctx);
    try {
      const dest = ctx.createMediaStreamDestination();
      contextCaps.set(ctx, dest);
      contexts.push({ ctx, dest });
      return dest;
    } catch (_) { return null; }
  }

  try {
    const proto = window.AudioNode && window.AudioNode.prototype;
    if (proto && proto.connect && !proto.connect.__vioPatched) {
      const originalConnect = proto.connect;
      function patchedConnect(destination, ...rest) {
        const result = originalConnect.call(this, destination, ...rest);
        try {
          const isSpeaker = destination && (
            (window.AudioDestinationNode && destination instanceof window.AudioDestinationNode) ||
            destination.constructor?.name === 'AudioDestinationNode'
          );
          if (isSpeaker && this.context) {
            const cap = ensureContextCapture(this.context);
            if (cap && destination !== cap) {
              try { originalConnect.call(this, cap); } catch (_) {}
            }
          }
        } catch (_) {}
        return result;
      }
      patchedConnect.__vioPatched = true;
      proto.connect = patchedConnect;
    }
  } catch (_) {}

  function patchAudioContext(name) {
    try {
      const Original = window[name];
      if (!Original || Original.__vioPatched) return;
      function Wrapped(...args) {
        const ctx = new Original(...args);
        ensureContextCapture(ctx);
        return ctx;
      }
      Object.setPrototypeOf(Wrapped, Original);
      Wrapped.prototype = Original.prototype;
      Wrapped.__vioPatched = true;
      window[name] = Wrapped;
    } catch (_) {}
  }
  patchAudioContext('AudioContext');
  patchAudioContext('webkitAudioContext');

  try {
    const originalPlay = HTMLMediaElement.prototype.play;
    if (originalPlay && !originalPlay.__vioPatched) {
      function patchedPlay(...args) {
        try {
          if (!mediaSeen.has(this)) {
            mediaSeen.add(this);
            const fn = this.captureStream || this.mozCaptureStream;
            if (fn) {
              const stream = fn.call(this);
              if (stream) mediaStreams.push(stream);
            }
          }
        } catch (_) {}
        return originalPlay.apply(this, args);
      }
      patchedPlay.__vioPatched = true;
      HTMLMediaElement.prototype.play = patchedPlay;
    }
  } catch (_) {}

  function streams() {
    const webAudio = [];
    for (const c of contexts) {
      try { if (c.dest?.stream?.getAudioTracks().length) webAudio.push(c.dest.stream); } catch (_) {}
    }
    // Prefer WebAudio capture when it exists to avoid double-capturing the same sound.
    if (webAudio.length) return webAudio;
    const media = [];
    for (const s of mediaStreams) {
      try { if (s?.getAudioTracks().length) media.push(s); } catch (_) {}
    }
    return media;
  }

  window.__vioCaptureInfo = () => ({
    contexts: contexts.length,
    mediaStreams: mediaStreams.length,
    streams: streams().length
  });

  window.__vioStartCapture = async () => {
    if (window.__vioRecorder?.state === 'recording') throw new Error('Recorder already running');
    const available = streams();
    if (!available.length) throw new Error('No capturable audio stream. Start Tanpura playback first.');

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext unavailable');
    const mixCtx = new AC();
    if (mixCtx.state === 'suspended') { try { await mixCtx.resume(); } catch (_) {} }
    const mixDest = mixCtx.createMediaStreamDestination();
    const sources = [];

    for (const stream of available) {
      try {
        const source = mixCtx.createMediaStreamSource(stream);
        source.connect(mixDest);
        sources.push(source);
      } catch (_) {}
    }
    if (!sources.length) throw new Error('Audio streams exist but could not be mixed');

    const choices = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'];
    let mime = '';
    for (const m of choices) {
      try { if (MediaRecorder.isTypeSupported(m)) { mime = m; break; } } catch (_) {}
    }
    const chunks = [];
    const recorder = mime ? new MediaRecorder(mixDest.stream, { mimeType: mime }) : new MediaRecorder(mixDest.stream);
    recorder.addEventListener('dataavailable', e => { if (e.data?.size) chunks.push(e.data); });
    window.__vioRecorder = recorder;
    window.__vioRecorderMeta = { chunks, mixCtx, sources, mime: recorder.mimeType || mime };
    recorder.start(500);
    return { mime: recorder.mimeType || mime, streams: available.length, sources: sources.length };
  };

  window.__vioStopCapture = async () => {
    const recorder = window.__vioRecorder;
    const meta = window.__vioRecorderMeta;
    if (!recorder || !meta) throw new Error('Recorder is not running');
    return await new Promise((resolve, reject) => {
      recorder.addEventListener('error', e => reject(e.error || new Error('MediaRecorder error')), { once: true });
      recorder.addEventListener('stop', async () => {
        try {
          const blob = new Blob(meta.chunks, { type: recorder.mimeType || meta.mime || 'audio/webm' });
          const dataUrl = await new Promise((ok, fail) => {
            const reader = new FileReader();
            reader.onload = () => ok(reader.result);
            reader.onerror = () => fail(reader.error || new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
          try { meta.sources.forEach(s => s.disconnect()); } catch (_) {}
          try { await meta.mixCtx.close(); } catch (_) {}
          window.__vioRecorder = null;
          window.__vioRecorderMeta = null;
          resolve({ mime: blob.type, size: blob.size, base64: String(dataUrl).split(',')[1] });
        } catch (err) { reject(err); }
      }, { once: true });
      try { recorder.stop(); } catch (err) { reject(err); }
    });
  };
})();
`;

async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function clickPattern(page, regex) {
  for (const frame of page.frames()) {
    for (const role of ['button','radio','tab']) {
      const el = await firstVisible(frame.getByRole(role, { name: regex }).catch ? frame.getByRole(role, { name: regex }) : frame.locator('__none__'));
      if (el) { await el.click({ timeout: 5000 }); return; }
    }
    const text = await firstVisible(frame.getByText(regex));
    if (text) { await text.click({ timeout: 5000 }); return; }
  }
  throw new Error(`Could not find pattern control: ${regex}`);
}

async function clickKey(page, key) {
  const rx = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'i');
  for (const frame of page.frames()) {
    const byButton = await firstVisible(frame.getByRole('button', { name: rx }));
    if (byButton) { await byButton.click({ timeout: 5000 }); return; }
    const byText = await firstVisible(frame.getByText(rx));
    if (byText) { await byText.click({ timeout: 5000 }); return; }
  }
  throw new Error(`Could not find key button: ${key}`);
}

async function clickPlayIfNeeded(page) {
  const regexes = [/Click\s+Here\s+To\s+Play/i, /^\s*Play\s*!?\s*$/i];
  for (const frame of page.frames()) {
    for (const rx of regexes) {
      const byButton = await firstVisible(frame.getByRole('button', { name: rx }));
      if (byButton) { await byButton.click({ timeout: 5000 }); return true; }
      const byText = await firstVisible(frame.getByText(rx));
      if (byText) { await byText.click({ timeout: 5000 }); return true; }
    }
  }
  return false;
}

function ffmpegConvert(input, output) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner','-loglevel','error','-y',
    '-i', input,
    '-vn','-ar','48000','-b:a','192k',
    output,
  ], { stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed for ${output}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!hasCommand('ffmpeg')) {
    throw new Error('ffmpeg not found. Install with: sudo apt update && sudo apt install -y ffmpeg');
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  }

  const output = path.resolve(args.output);
  const rawDir = path.join(output, 'original_network_audio');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(rawDir, { recursive: true });

  const selectedPatterns = args.onlyPattern ? PATTERNS.filter(p => p.id === args.onlyPattern) : PATTERNS;
  const selectedKeys = args.onlyKey ? [args.onlyKey] : KEYS;
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript({ content: CAPTURE_INIT });

  let currentCombo = 'startup';
  const rawSeen = new Set();
  const rawWrites = new Set();
  page.on('response', response => {
    const task = (async () => {
      try {
        const headers = await response.allHeaders();
        const type = (headers['content-type'] || '').toLowerCase();
        const pathname = (() => { try { return new URL(response.url()).pathname; } catch { return ''; } })();
        const ext = path.extname(pathname).toLowerCase();
        const audio = type.startsWith('audio/') || ['.mp3','.wav','.ogg','.oga','.m4a','.aac','.webm','.flac'].includes(ext);
        if (!audio) return;
        const body = await response.body();
        if (!body?.length) return;
        const hash = sha256(body);
        if (rawSeen.has(hash)) return;
        rawSeen.add(hash);
        const suffix = extensionFor(type, response.url());
        const file = path.join(rawDir, `${currentCombo}__${hash.slice(0,12)}${suffix}`);
        await fs.writeFile(file, body);
        console.log(`[raw] saved complete network audio: ${path.relative(process.cwd(), file)}`);
      } catch (_) {}
    })();
    rawWrites.add(task);
    task.finally(() => rawWrites.delete(task));
  });

  const urls = args.url ? [args.url] : [PRIMARY_URL, FALLBACK_URL];
  let loaded = false;
  for (const url of urls) {
    try {
      console.log(`[open] ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);
      loaded = true;
      break;
    } catch (err) {
      console.warn(`[open] failed: ${url}: ${err.message}`);
    }
  }
  if (!loaded) throw new Error('Could not open the Tanpura site');

  const manifest = [];
  let previousPattern = '';

  for (const pattern of selectedPatterns) {
    console.log(`\n=== ${pattern.id.toUpperCase()} ===`);
    await clickPattern(page, pattern.label);
    if (previousPattern !== pattern.id) await page.waitForTimeout(args.patternSettle * 1000);
    previousPattern = pattern.id;

    for (const key of selectedKeys) {
      const slug = keySlug(key);
      const name = `${pattern.id}_${slug}`;
      const mp3 = path.join(output, `${name}.mp3`);
      currentCombo = name;

      if (!args.force) {
        try {
          const st = await fs.stat(mp3);
          if (st.size > 1000) {
            console.log(`[skip] ${name} already exists (${st.size} bytes)`);
            continue;
          }
        } catch (_) {}
      }

      console.log(`\n[capture] ${pattern.id} / ${key} / ${args.seconds}s`);
      await clickKey(page, key);
      await clickPlayIfNeeded(page);
      await page.waitForTimeout(args.settle * 1000);

      let info = await page.evaluate(() => window.__vioCaptureInfo?.() || null);
      if (!info?.streams) {
        await clickPlayIfNeeded(page);
        await page.waitForTimeout(1200);
        info = await page.evaluate(() => window.__vioCaptureInfo?.() || null);
      }
      if (!info?.streams) throw new Error(`No capturable audio stream for ${name}. Try --headed and verify the site is audibly playing.`);

      const started = await page.evaluate(() => window.__vioStartCapture());
      console.log(`[recording] ${name} (${started.streams} stream${started.streams === 1 ? '' : 's'})`);
      await sleep(args.seconds * 1000);
      const captured = await page.evaluate(() => window.__vioStopCapture());
      const bytes = Buffer.from(captured.base64, 'base64');

      const temp = path.join(os.tmpdir(), `vio-${name}-${Date.now()}.webm`);
      await fs.writeFile(temp, bytes);
      ffmpegConvert(temp, mp3);
      await fs.unlink(temp).catch(() => {});
      const st = await fs.stat(mp3);
      console.log(`[done] ${path.relative(process.cwd(), mp3)} (${(st.size / 1024 / 1024).toFixed(2)} MB)`);

      manifest.push({
        pattern: pattern.id,
        key,
        file: path.basename(mp3),
        seconds: args.seconds,
        sourceUrl: page.url(),
        capturedAt: new Date().toISOString(),
        encoded: 'mp3 192k / 48kHz',
      });
    }
  }

  await Promise.allSettled([...rawWrites]);
  await fs.writeFile(path.join(output, 'capture-manifest.json'), JSON.stringify({
    source: page.url(),
    requestedSecondsPerCombination: args.seconds,
    combinations: manifest,
  }, null, 2));

  await browser.close();
  console.log(`\nComplete. Output: ${output}`);
  console.log(`Captured MP3s: ${manifest.length}`);
  console.log(`Any complete network audio files found were preserved in: ${rawDir}`);
}

main().catch(err => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
