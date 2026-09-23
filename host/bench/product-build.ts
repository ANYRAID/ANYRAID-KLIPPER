import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {productBuildSmoke} from '../test/helpers/product-build-smoke.ts';
const dir=await mkdtemp(join(tmpdir(),'product-build-bench-')),output=join(dir,'app'),timings:number[][]=[[],[]];
try{
 await buildProductHost(output);await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),join(output,'node_modules'),'dir');
 let expected:unknown;
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
  const work=join(dir,`${run}-${mode}`);await mkdir(work);const probe=await productBuildSmoke(output,work);
  if(!mode){const source=(await readFile(probe,'utf8')).replace(/'\.\/host\/src\/([^']+)\.js'/g,(_,path:string)=>JSON.stringify(new URL('../src/'+path+'.ts',import.meta.url).href));await writeFile(probe,source);}
  const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_DISABLE_COMPILE_CACHE:'1',NODE_OPTIONS:mode?'--no-experimental-strip-types':''};
  for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
  const start=performance.now(),result=JSON.parse(execFileSync(process.execPath,[probe],{env,encoding:'utf8',timeout:15000,maxBuffer:4*1024**2})),elapsed=performance.now()-start;
  expected??=result;assert.deepEqual(result,expected);if(run>=3)timings[mode].push(elapsed);
 }
 const stats=timings.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};}),limits={ratio:1.2,slackMs:20};
 console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['sourceTS','compiledJS'],timing:stats,limits,scope:'Cold child process, journal/database/listing/metadata/thumbnail workers, spectrum cancellation and reuse, shaper fit, native 1000-step trajectory and PDF assets. Exact output equality; excludes build and dependency install; no physical printing.'}));
 assert(stats[1].medianMs<stats[0].medianMs*limits.ratio+limits.slackMs);assert(stats[1].p95Ms<stats[0].p95Ms*limits.ratio+limits.slackMs);
}finally{await rm(dir,{recursive:true,force:true});}
