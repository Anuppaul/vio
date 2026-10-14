// Use the existing static-export Chromium acceptance suite without changing Android behavior.
import { spawnSync } from 'node:child_process';

const run=spawnSync(process.execPath,['scripts/test-android-export.mjs'],{
  stdio:'inherit',
  env:{...process.env,VIO_DESKTOP_SMOKE:'1'}
});
if(run.error)throw run.error;
process.exit(run.status??1);
