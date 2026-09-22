import { runFullTunerRegression } from '../lib/tuner-full-regression';

const report=runFullTunerRegression();

if(process.argv.includes('--json')){
  console.log(JSON.stringify(report,null,2));
  if(!report.summary.pass)process.exitCode=1;
}else{

console.log('');
console.log('VIO Sound Tuner Full Regression');
console.log('================================');
console.log(`Sample rate: ${report.sampleRate} Hz`);
console.log(`Frame step: ${report.frameStepMs.toFixed(2)} ms`);
console.log('');

console.log('Static cases');
for(const result of report.staticCases){
  const mark=result.pass?'PASS':'FAIL';
  const frequency=result.finalFrequency===null?'—':`${result.finalFrequency.toFixed(2)} Hz`;
  const cents=result.finalCentsError===null?'—':`${result.finalCentsError.toFixed(2)} cents`;
  console.log(
    `${mark.padEnd(4)} | ${result.name} | final=${result.finalNote??'—'} ${frequency} | error=${cents} | lock=${result.firstLockMs===null?'—':result.firstLockMs.toFixed(1)+' ms'} | octaveErrors=${result.octaveErrorFrames} | falsePos=${result.falsePositiveFrames}`
  );
}

console.log('');
console.log('Temporal cases');
for(const result of report.temporalCases){
  const mark=result.pass?'PASS':'FAIL';
  console.log(
    `${mark.padEnd(4)} | ${result.name} | final=${result.finalNote??'—'} | switch=${result.switchLatencyMs===null?'—':result.switchLatencyMs.toFixed(1)+' ms'} | dropoutHeld=${result.dropoutHeldFrames} | release=${result.releaseSeen?'yes':'no'} | idle=${result.idleSeenAfterRelease?'yes':'no'} | falsePos=${result.falsePositiveFrames}`
  );
}

console.log('');
console.log(
  `Summary: static ${report.summary.staticPassed}/${report.summary.staticTotal}, temporal ${report.summary.temporalPassed}/${report.summary.temporalTotal}, octave errors ${report.summary.octaveErrorFrames}, false-positive frames ${report.summary.falsePositiveFrames}`
);
console.log(`Overall: ${report.summary.pass?'PASS':'FAIL'}`);

if(!report.summary.pass)process.exitCode=1;
}
