// Source/packaging contract only. This is NOT a device playback or thermal test.
// No GitHub Actions are triggered by this test.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const read = file => readFile(file, 'utf8');
const [service, bridge, main, sync, manifest, tanpura, metronome, ear, jsBridge, workflow] =
  await Promise.all([
    'android/app/src/main/java/com/anuppaul/vio/BackgroundAudioService.java',
    'android/app/src/main/java/com/anuppaul/vio/BackgroundAudioPlugin.java',
    'android/app/src/main/java/com/anuppaul/vio/MainActivity.java',
    'scripts/sync-android.mjs',
    'android/app/src/main/AndroidManifest.xml',
    'components/Tanpura.tsx',
    'components/Metronome.tsx',
    'components/EarTuner.tsx',
    'lib/background-audio.ts',
    '.github/workflows/android-apk.yml'
  ].map(read));

const required = [
  ['FGS type', /android:foregroundServiceType="mediaPlayback"/, manifest],
  ['FGS permission', /FOREGROUND_SERVICE_MEDIA_PLAYBACK/, manifest],
  ['WAKE_LOCK permission', /android.permission.WAKE_LOCK/, manifest],
  ['notification permission', /android.permission.POST_NOTIFICATIONS/, manifest],
  ['service not exported', /android:name="\.BackgroundAudioService"[\s\S]*?android:exported="false"/, manifest],
  ['native bridge registration', /registerPlugin\(BackgroundAudioPlugin.class\)/, main],
  ['sync generator registration', /registerPlugin\(BackgroundAudioPlugin.class\)/, sync],
  ['sync generator service declaration', /serviceMarker/, sync],
  ['service notification stop', /ACTION_STOP/, service],
  ['service notification pause', /ACTION_PAUSE/, service],
  ['service uses foreground immediately', /setForeground\(buildNotification\(\)\)/, service],
  ['media player holds audio wake lock', /setWakeMode\(this, PowerManager.PARTIAL_WAKE_LOCK\)/, service],
  ['native PCM worker', /new Thread\(this, "vio-screen-off-pcm"\)/, service],
  ['metronome PCM stream', /AudioTrack.MODE_STREAM/, service],
  ['native audio focus', /requestAudioFocus\(/, service],
  ['service audio focus resume', /AUDIOFOCUS_GAIN && pausedByFocus/, service],
  ['service user-initiated only', /ACTION_PLAY\.equals\(action\)/, service],
  ['Tanpura native playback', /native\.playTanpura/, tanpura],
  ['Metronome native playback', /native\.playMetronome/, metronome],
  ['Ear native playback', /native\.playEar/, ear],
  ['WebView-independent native API', /Capacitor.isNativePlatform\(\)/, jsBridge],
  ['no global screen-wake flag', /getBridge\(\)\.getWebView\(\)/, main]
];
for(const [label, pattern, data] of required)assert.match(data, pattern, label);
assert.doesNotMatch(main, /FLAG_KEEP_SCREEN_ON/);
assert.doesNotMatch(sync, /FLAG_KEEP_SCREEN_ON/);
assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
assert.doesNotMatch(workflow, /^\s+push:\s*$/m);

const assets = [
  'public/assets/tanpura/sa-pa_C.mp3',
  'public/assets/tanpura/sa-ma_A.mp3',
  'public/assets/ear/A4.mp3',
  'public/assets/metronome/click.wav',
  'public/assets/metronome/tabla-ge.wav',
  'public/assets/metronome/drum-kick.wav'
];
for(const path of assets)assert.ok((await stat(path)).size > 2000, 'Missing offline native audio asset: '+path);

console.log(JSON.stringify({result:'PASS',checks:required.length+4+assets.length,
  modes:['tanpura','metronome','ear'],
  limits:['No Android compilation performed','No screen-off playback, latency, gapless looping or phone temperature measured'],
  githubActions:'not triggered; APK workflow remains manual-only'},null,2));
