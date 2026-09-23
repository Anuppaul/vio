import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Never overwrite the normal Vercel build settings or point an APK at a URL.
const config = JSON.parse(await readFile('capacitor.config.json', 'utf8'));
assert.equal(config.webDir, 'out');
assert.equal(config.server?.url, undefined, 'The APK must bundle local assets');
await rm('out', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VIO_ANDROID_BUILD: '1', NEXT_PUBLIC_VIO_NATIVE: '1', NEXT_TELEMETRY_DISABLED: '1' }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// The repository keeps the original 60-second Tanpura masters.
// Android bundles only the approved compact ~10-second loops.
const compactTanpura = spawnSync(process.execPath, ['scripts/compact-tanpura-android.mjs'], {
  stdio: 'inherit',
  env: process.env
});
if (compactTanpura.error) throw compactTanpura.error;
if (compactTanpura.status !== 0) process.exit(compactTanpura.status ?? 1);

const routes = ['index', 'sound-tuner', 'scale-practice', 'tanpura', 'exercise', 'metronome'];
for (const route of routes) {
  const html = await readFile(resolve('out', `${route}.html`), 'utf8');
  assert.match(html, /vio-native/, `${route} is not a native export`);
  for (const target of routes) {
    assert.ok(html.includes(`href="/${target}.html"`), `${route} has no local link to ${target}`);
  }
}
const keys = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const tanpuraAudio = ['sa-pa','sa-ma'].flatMap(pattern => keys.map(key => `tanpura/${pattern}_${key}.mp3`));
const audio = [...tanpuraAudio];

const compactManifest = JSON.parse(
  await readFile('out/assets/tanpura/android-compact-manifest.json', 'utf8')
);
assert.equal(compactManifest.files?.length, 24, 'Expected 24 compact Tanpura files');
assert.ok(
  compactManifest.totals?.reductionPercent > 70,
  'Tanpura compaction did not reduce the Android payload enough'
);
for (const file of tanpuraAudio) {
  const info = await stat(`out/assets/${file}`);
  assert.ok(
    info.size < 400 * 1024,
    `Tanpura file is still too large for the compact Android bundle: ${file}`
  );
}

for (let midi=36; midi<=96; midi++) audio.push(`exercise/midi-${midi}.wav`);
for (const file of ['click','click-accent','tabla-na','tabla-tin','tabla-ge','drum-kick','drum-snare','drum-hihat']) audio.push(`metronome/${file}.wav`);
for (const file of ['G3','D4','A4','E5']) audio.push(`ear/${file}.mp3`);
for (const file of audio) assert.ok((await stat(`out/assets/${file}`)).size>0, `Missing offline audio: ${file}`);
await rm('out/sw.js', { force: true });
await writeFile('out/webview-error.html', '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Update Android System WebView</title><body style="font:18px system-ui;padding:32px;background:#f8f9fd;color:#273249"><h1>VIO</h1><p>Please update Android System WebView or Chrome, then reopen VIO.</p><p>This app needs WebView 111 or newer.</p></body></html>');
await writeFile('out/native-build.json', JSON.stringify({
  platform: 'android',
  localAssets: true,
  routes,
  requiredAudioFiles: audio.length,
  tanpuraCompact: true,
  tanpuraFiles: 24,
  tanpuraReductionPercent: compactManifest.totals.reductionPercent
}, null, 2));
console.log(`Android export verified: ${routes.length} pages and ${audio.length} required audio files.`);
