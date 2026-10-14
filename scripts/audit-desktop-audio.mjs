// Offline source/package audit only. This does NOT run GitHub Actions, the
// installed WebKitGTK renderer, or a physical microphone/speaker.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const read=path=>readFile(path,'utf8');
const config=JSON.parse(await read('src-tauri/tauri.conf.json'));
const pkg=JSON.parse(await read('package.json'));
const lock=JSON.parse(await read('package-lock.json'));
const cargo=await read('src-tauri/Cargo.toml');
const cargoLock=await read('src-tauri/Cargo.lock');
const native=await read('src-tauri/src/main.rs');
const workflow=await read('.github/workflows/desktop-build.yml');
const exportScript=await read('scripts/export-desktop.mjs');
const filesToCheck=[
  'public/tuner-capture-worklet.js','public/tuner-consensus-worker.js',
  'public/audio-worklets/vio-capture.js'
];
for(const path of filesToCheck)assert.ok((await stat(path)).size>0,'Missing worklet/worker: '+path);
assert.match(workflow,/on:\s*\n\s*workflow_dispatch:/,'Desktop workflow must remain manual');
assert.doesNotMatch(workflow,/^\s+push:\s*$/m,'Automatic GitHub Actions must remain disabled');
assert.match(native,/set_enable_media_stream\(true\)/);
assert.match(native,/set_enable_webrtc\(true\)/);
assert.match(native,/PermissionKind::Microphone/);
assert.match(native,/PermissionKind::Camera \| PermissionKind::DisplayCapture => PermissionResponse::Deny/);
assert.match(cargo,/webkit2gtk = \{ version = "=2\.0\.2", features = \["v2_38"\] \}/);
assert.match(cargoLock,/name = "webkit2gtk"\nversion = "2\.0\.2"/);
assert.equal(lock.packages['node_modules/@tauri-apps/cli']?.version,'2.12.2');
assert.equal(pkg.scripts['build:desktop:web'],'node scripts/export-desktop.mjs');
assert.match(exportScript,/NEXT_PUBLIC_VIO_DESKTOP: '1'/);
const deb=config.bundle.linux.deb;
for(const name of ['libwebkit2gtk-4.1-0','gstreamer1.0-plugins-good','gstreamer1.0-plugins-bad','gstreamer1.0-libav','gstreamer1.0-pulseaudio']){
  assert.ok(deb.depends.some(dep=>dep.startsWith(name)),'Missing Debian dependency '+name);
}

let wav=0,mp3=0;
for(const directory of ['ear','exercise','metronome','tanpura']){
  for(const filename of await readdir('public/assets/'+directory)){
    if(!/\.(mp3|wav)$/i.test(filename))continue;
    const path=resolve('public/assets',directory,filename);
    const buffer=await readFile(path);
    assert.ok(buffer.length>1024,'Truncated audio: '+path);
    if(filename.endsWith('.wav')){
      assert.equal(buffer.toString('ascii',0,4),'RIFF','Not RIFF: '+path);
      assert.equal(buffer.toString('ascii',8,12),'WAVE','Not WAVE: '+path);
      wav++;
    }else{
      const id3=buffer.toString('ascii',0,3)==='ID3';
      let mpegSync=false;
      for(let i=0;i<Math.min(2048,buffer.length-1);i++){
        if(buffer[i]===0xff&&(buffer[i+1]&0xe0)===0xe0){mpegSync=true;break}
      }
      assert.ok(id3||mpegSync,'MP3 frame/ID3 header missing: '+path);
      mp3++;
    }
  }
}
assert.ok(wav>=69,'Missing expected WAV samples');
assert.ok(mp3>=59,'Missing expected MP3 samples');
console.log(JSON.stringify({
  status:'PASS: offline source/asset checks',
  tauri:pkg.devDependencies['@tauri-apps/cli'],
  wavFiles:wav,
  mp3Files:mp3,
  gstreamerDependencies:deb.depends.length,
  actions:'manual only',
  limitation:'No native WebKitGTK speaker or microphone tests were run.'
},null,2));
