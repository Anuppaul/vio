import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

function run(command,args,options={}) {
  const result=spawnSync(command,args,{stdio:'inherit',...options});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
const signed=process.argv.includes('--release');
if(signed)for(const name of ['VIO_KEYSTORE_PATH','VIO_KEYSTORE_PASSWORD','VIO_KEY_ALIAS','VIO_KEY_PASSWORD'])assert.ok(process.env[name],`${name} is required for a signed release; do not commit a keystore.`);
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;
assert.ok(sdk,'Set ANDROID_HOME to your Android SDK (API 36 and Build Tools 36).');
run(process.execPath,['scripts/export-android.mjs']);
run(process.execPath,['scripts/sync-android.mjs']);
const variant=signed?'release':'debug';
const abiFilters=(process.env.VIO_ANDROID_ABIS||'')
  .split(',')
  .map(value=>value.trim())
  .filter(Boolean);
const gradlew=process.platform==='win32'?'gradlew.bat':'./gradlew';
run(gradlew,['--no-daemon','--max-workers=2',`assemble${signed?'Release':'Debug'}`,'lintDebug','testDebugUnitTest'],{cwd:'android'});

const tools=(await readdir(join(sdk,'build-tools'))).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
assert.ok(tools.length,'Android Build Tools not installed');
const toolDir=join(sdk,'build-tools',tools.at(-1));
const source=`android/app/build/outputs/apk/${variant}/app-${variant}.apk`;
run(join(toolDir,process.platform==='win32'?'apksigner.bat':'apksigner'),['verify','--verbose','--print-certs',source]);
const pkg=JSON.parse(await readFile('package.json','utf8'));
const config=JSON.parse(await readFile('capacitor.config.json','utf8'));
const filename=`vio-${pkg.version}-${variant}.apk`;
await mkdir('release',{recursive:true});
// Keep a single current APK per build type instead of accumulating binaries.
for(const file of await readdir('release'))if(new RegExp(`^vio-[0-9.]+-${variant}\\.apk(?:\\.sha256)?$`).test(file))await rm(join('release',file));
await copyFile(source,join('release',filename));
const bytes=await readFile(join('release',filename));
assert.ok(bytes.length<95*1024*1024,'APK too large to store safely in GitHub; use a Release asset.');
const checksum=createHash('sha256').update(bytes).digest('hex');
await writeFile(join('release',`${filename}.sha256`),`${checksum}  ${filename}\n`);
const details={
  appId:config.appId,
  version:pkg.version,
  versionCode:Number(process.env.VIO_VERSION_CODE||1),
  variant,
  sourceCommit:process.env.GITHUB_SHA||null,
  file:filename,
  bytes:(await stat(join('release',filename))).size,
  sha256:checksum,
  capacitor:pkg.dependencies['@capacitor/core'],
  builtAt:new Date().toISOString(),
  bundledOffline:true,
  signing:signed?'user-provided release key':'Android development key; not for Play Store',
  minified:signed,
  shrinkResources:signed,
  abis:abiFilters.length?abiFilters:['universal']
};
await writeFile(`release/build-${variant}.json`,JSON.stringify(details,null,2)+'\n');
console.log(`APK verified and copied to ${resolve('release',filename)}`);
if(abiFilters.length)console.log(`Android ABI filter: ${abiFilters.join(', ')}`);
if(signed)console.log('Release shrinking: R8 minify + resource shrink enabled');
