import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/compare-motion-runtimes.mjs',import.meta.url));
for(const mode of ['success','source','silent','mutate'] as const)test(`runtime comparison freezes all input files and handles ${mode}`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'runtime-compare-test-')),compiled=join(dir,mode==='source'?'source':'compiled'),fixture=join(dir,'fixture.mjs'),fake=join(dir,'runtime.cjs'),report=join(dir,'results');
 try{
  mkdirSync(compiled);writeFileSync(join(compiled,'module.js'),'export const value=1;');writeFileSync(fixture,'// fixture\n');
  writeFileSync(fake,'#!'+process.execPath+'\n'+`if(process.argv.includes('-p'))console.log(JSON.stringify(process.versions));else {${mode==='mutate'?`require('node:fs').unlinkSync(${JSON.stringify(join(compiled,'module.js'))});`:''}${mode==='silent'?'':"console.log('motion:loading\\nmotion:loaded\\nmotion:verified');"}}\n`);chmodSync(fake,0o700);
  const run=spawnSync(process.execPath,[script,'--fixture',fixture,'--first',fake,'--second',fake,'--pairs',mode==='mutate'?'1':'2','--report',report,'--execution',mode==='source'?'source':'compiled'],{encoding:'utf8',timeout:15000});
  const data=JSON.parse(readFileSync(join(report,'report.json'),'utf8'));
  if(mode==='success'||mode==='source'){assert.equal(run.status,0,run.stderr);assert.equal(data.state,'completed');assert.deepEqual(data.results.map((r:any)=>[r.pair,r.runtime]),[[0,0],[0,1],[1,1],[1,0]]);assert(data.results.every((r:any)=>r.verified));assert(data.inputs[(mode==='source'?'source':'compiled')+'/module.js']);assert.equal(data.execution,mode==='source'?'source':'compiled');assert.equal(data.active,null);}
  else{assert.equal(run.status,1);assert.equal(data.state,'failed');if(mode==='silent'){assert.equal(data.results.length,1);assert.equal(data.results[0].status,0);assert.equal(data.results[0].verified,false);}else assert(data.results.some((r:any)=>r.error==='Frozen input hashes changed'));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('runtime comparison rejects unbounded sampling before filesystem access',()=>{
 const result=spawnSync(process.execPath,[script,'--fixture','/missing','--first','/missing','--second','/missing','--pairs','65','--report','/missing'],{encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/1\.\.64 pairs/);
});
