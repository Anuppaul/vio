// Static thermal-regression contract for Android APK; does not measure heat,
// replace on-device profiling, or start GitHub Actions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=path=>readFile(path,'utf8');
const [activity,pitch,tan,metro,ear,exercise,scale,tuner,style,workflow] =
 await Promise.all([
  'android/app/src/main/java/com/anuppaul/vio/MainActivity.java',
  'android/app/src/main/java/com/anuppaul/vio/NativePitchPlugin.java',
  'components/Tanpura.tsx','components/Metronome.tsx',
  'components/EarTuner.tsx','components/Exercise.tsx',
  'components/ScalePractice.tsx','components/SoundTuner.tsx',
  'app/native.css','.github/workflows/android-apk.yml'
 ].map(read));

assert.doesNotMatch(activity,/FLAG_KEEP_SCREEN_ON/,'Display must not be pinned on');
assert.match(pitch,/handleOnPause\(\)[\s\S]{0,200}stopCapture\(\)/,
 'Native pitch DSP must stop when activity pauses');
assert.match(tan,/nodesRef\.current\.delete\(osc\)/,'Synth nodes must self-release');
assert.match(tan,/nodesRef\.current\.clear\(\)/,'Synth nodes must clear on Stop');
assert.match(tan,/cacheRef\.current\.size>2/,'Decoded Tanpura cache must remain bounded');
assert.match(tan,/ctx\.close\(\)/,'Tanpura must release output context');
assert.match(tan,/visibilitychange/,'Tanpura must stop on native background');
assert.match(style,/\.vio-native \.tan-visual\.playing \.tan-ring\s*\{[\s\S]*?animation:\s*none/,
 'Continuous native Tanpura decoration should be disabled');
assert.equal((metro.match(/createDynamicsCompressor\(/g)||[]).length,1,
 'Metronome must not instantiate compressors per beat');
assert.match(metro,/visualTimerRef\.current=setTimeout\(animate,60\)/);
assert.match(metro,/cancelAnimationFrame\(rafRef\.current\)/);
assert.match(metro,/startEpochRef\.current\+\+/,'Late starts must be canceled');
assert.doesNotMatch(metro,/useEffect\(\(\)=>\{ensureAudio\(\)/,
 'Metronome cannot open a running audio engine just by mounting');
assert.match(ear,/sampleCacheRef\.current\.size>4/);
assert.match(ear,/ctx\.close\(\)/);
assert.match(exercise,/setInterval\(\(\)=>setNow\(Date\.now\(\)\),1000\)/);
assert.match(exercise,/!settings\.challengeMode\|\|settings\.timeLimitMinutes<=0/);
assert.match(scale,/visibilitychange/);
assert.match(tuner,/visibilitychange/);
assert.match(workflow,/on:\s*\n\s*workflow_dispatch:/);
assert.doesNotMatch(workflow,/^\s+push:\s*$/m,
 'APK GitHub Actions must remain manual-only');

console.log('PASS: Android thermal source regression contracts');
console.log('LIMITATION: No thermal, battery, CPU, hardware audio or APK build measurement was performed.');
