import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temp=await mkdtemp(join(tmpdir(),'vio-tuner-regression-'));
let exitCode=1;

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

  if(compile.status!==0){
    exitCode=compile.status??1;
  }else{
    const compiled=join(temp,'scripts','tuner-regression-entry.js');
    const run=spawnSync(process.execPath,[compiled,...process.argv.slice(2)],{
      cwd:root,
      stdio:'inherit',
      env:{...process.env,NODE_PATH:join(root,'node_modules')}
    });
    exitCode=run.status??1;
  }
}finally{
  await rm(temp,{recursive:true,force:true}).catch(()=>{});
}

process.exitCode=exitCode;
