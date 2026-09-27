import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'kconfig-bench-'));
try{
 const samples:number[]=[];
 const expected=JSON.parse(await readFile(new URL('../contracts/kconfig-autoconf-reference.json',import.meta.url),'utf8')).cases.find((c:{file:string;lowlevel:boolean})=>c.file==='test/configs/atmega2560.config'&&!c.lowlevel).sha256;
 for(let run=0;run<15;run++){
  const output=join(directory,'header-'+run+'.h');
  const start=performance.now();
  const result=spawnSync(process.execPath,[join(root,'scripts/kconfig-genconfig.mjs'),'src/Kconfig'],{cwd:root,env:{...process.env,srctree:root,CONFIG_:'CONFIG_',KCONFIG_CONFIG:join(root,'test/configs/atmega2560.config'),KCONFIG_AUTOHEADER:output,KCONFIG_AUTOHEADER_HEADER:''},encoding:'utf8'});
  const elapsed=performance.now()-start;assert.equal(result.status,0,result.stderr);
  assert.equal(createHash('sha256').update(await readFile(output)).digest('hex'),expected);
  if(run>=3)samples.push(elapsed);
 }
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,configuration:'test/configs/atmega2560.config',compileCacheDisabled:process.env.NODE_DISABLE_COMPILE_CACHE==='1',warmups:3,runs:12,medianMs:(samples[5]+samples[6])/2,p95Ms:samples[11],sha256:expected,scope:'New Node process, TypeScript loading, full Kconfig parse, config file read, resolution and atomic autoconf write. Warm filesystem cache and, unless disabled, warmed Node compile cache. Build-time path only.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
