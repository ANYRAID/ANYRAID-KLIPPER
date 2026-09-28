import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
test('pinned native simulator executes AVR instructions with exact observable pulse timing',t=>{
 const source=process.env.SIMULAVR_SOURCE;if(!source)throw new Error('Set SIMULAVR_SOURCE to the clean pinned checkout and build host/build/libsim.a first');
 const dir=mkdtempSync(join(tmpdir(),'simulavr-check-'));
 const run=(program:string,args:string[])=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:60000});assert.equal(r.status,0,String(r.error??r.stderr));return r.stdout;};
 try{
  const elf=join(dir,'pulse.elf'),binary=join(dir,'core-check');
  run(process.env.AVR_CC??'avr-gcc',['-mmcu=atmega644','-Os',resolve(host,'test/fixtures/simulavr/pulse.c'),'-o',elf]);
  run(process.env.CXX??'g++',['-std=c++11','-O2','-I'+resolve(source,'include'),resolve(host,'test/fixtures/simulavr/core-check.cpp'),'-Wl,--whole-archive',resolve(host,'build/libsim.a'),'-Wl,--no-whole-archive','-o',binary]);
  const samples:number[]=[];let expected:unknown;
  for(let i=0;i<10;i++){
   const started=performance.now(),result=JSON.parse(run(binary,[elf])),elapsed=performance.now()-started;
   assert.ok(result.edges>=5000);assert.ok(result.clockNs>=1000000&&result.clockNs<1000100);
   assert.equal(result.highNs,124);assert.equal(result.lowNs,248);
   if(i)assert.deepEqual(result,expected);else expected=result;
   if(i>=3)samples.push(elapsed);
  }
  t.diagnostic(JSON.stringify({node:process.version,warmups:3,simulatedNs:1000000,result:expected,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Native process startup, ELF loading, AVR execution and every pin-edge assertion; excludes Node serial bridge and PTY'}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
