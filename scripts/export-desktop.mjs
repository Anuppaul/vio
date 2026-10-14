import { spawnSync } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await rm('out', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VIO_DESKTOP_BUILD: '1', NEXT_PUBLIC_VIO_NATIVE: '1', NEXT_TELEMETRY_DISABLED: '1' }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const routes = ['index', 'sound-tuner', 'scale-practice', 'tanpura', 'exercise', 'metronome'];
for (const route of routes) {
  const html = await readFile(`out/${route}.html`, 'utf8');
  assert.match(html, /vio-native/, `Missing offline navigation: ${route}`);
  for (const target of routes) {
    assert.ok(html.includes(`href="/${target}.html"`), `${route}: missing offline route ${target}`);
  }
}
const sounds = ['G3','D4','A4','E5'].map(x => `ear/${x}.mp3`);
for (const note of ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B']) {
  for (const mode of ['sa-pa','sa-ma']) sounds.push(`tanpura/${mode}_${note}.mp3`);
}
for (let midi=36; midi<=96; midi++) sounds.push(`exercise/midi-${midi}.wav`);
for (const sound of ['click','click-accent','tabla-na','tabla-tin','tabla-ge','drum-kick','drum-snare','drum-hihat']) sounds.push(`metronome/${sound}.wav`);
for (const sound of sounds) assert.ok((await stat(`out/assets/${sound}`)).size > 0, `Missing offline audio: ${sound}`);
await rm('out/sw.js', { force: true });
await writeFile('out/desktop-build.json', JSON.stringify({ platform:'desktop', offline:true, routes, audioFiles:sounds.length }, null, 2));
console.log(`Desktop export: verified ${routes.length} routes and ${sounds.length} audio assets.`);
