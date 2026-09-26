import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productHostFixture} from '../test/helpers/product-host-profile.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
const samples:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const dir=await mkdtemp(join(tmpdir(),'reinitialize-bench-')),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<void>();
 const profiles:Awaited<ReturnType<typeof productHostFixture>>[]=[];let running:Promise<void>|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined;
 const create=async()=>{assert(profiles.every(p=>p.released));const f=await productHostFixture(dir);profiles.push(f);return f.profile;};
 try{
  let start:number;
  if(mode){running=runProductHost(create,abort.signal,()=>ready.resolve(),control);void running.catch(error=>ready.reject(error));await ready.promise;start=performance.now();await control.reinitialize();}
  else{const p=await create();service=await startConfiguredProductService(p.reader,p.policies,p.product,p.options,abort.signal);start=performance.now();await service.close();service=undefined;await p.release();const next=await create();service=await startConfiguredProductService(next.reader,next.policies,next.product,next.options,abort.signal);}
  const elapsed=performance.now()-start;if(run>=3)samples[mode].push(elapsed);
  assert.equal(profiles.length,2);assert(profiles[0].released);assert.equal(profiles[1].released,false);assert(profiles.every(p=>p.transport.firmware.every(f=>f.motion.length===0)));
 }finally{abort.abort();await running;await service?.close();for(const p of profiles)await p.profile.release();await rm(dir,{recursive:true,force:true});}
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};},baseline=stats(samples[0]),current=stats(samples[1]);
console.log(JSON.stringify({node:process.version,warmup:3,runs:11,baseline,current,scope:'Alternating manual retirement/profile recreation/UART service startup vs explicit host-control reinitialization, including journal close/reopen and trusted factory; initial startup excluded; simulated devices, no file replay or real printing.'},null,2));
assert(current.medianMs<=baseline.medianMs*1.1+10);assert(current.p95Ms<=baseline.p95Ms*1.2+10);
