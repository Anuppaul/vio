import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root=resolve(new URL('..',import.meta.url).pathname);
const temp=await mkdtemp(join(tmpdir(),'vio-tuner-regression-'));

try{
  const tsc=join(root,'node_modules','typescript','bin','tsc');
  const entry=join(root,'scripts','tuner-regression-entry.ts');
  const compile=spawnSync(process.execPath,[
    tsc,
    entry,
    '--outDir',temp,
    '--target','ES2020',
    '--module','commonjs',
    '--moduleResolution','node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict','false',
    '--noEmitOnError','true'
  ],{
    cwd:root,
    stdio:'inherit'
  });

  if(compile.status!==0)process.exit(compile.status??1);

  const compiled=join(temp,'scripts','tuner-regression-entry.js');
  const run=spawnSync(process.execPath,[compiled],{
    cwd:root,
    stdio:'inherit',
    env:{...process.env,NODE_PATH:join(root,'node_modules')}
  });
  process.exit(run.status??1);
}finally{
  await rm(temp,{recursive:true,force:true}).catch(()=>{});
}
