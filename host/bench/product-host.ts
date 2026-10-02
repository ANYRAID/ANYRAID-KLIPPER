import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productHostFixture} from '../test/helpers/product-host-profile.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const dir=await mkdtemp(join(tmpdir(),'host-bench-')),f=await productHostFixture(dir),abort=new AbortController();let ready=0;
 try{
  const used=process.cpuUsage(),start=performance.now();
  if(mode)await runProductHost(async()=>f.profile,abort.signal,()=>{ready++;abort.abort(new Error('benchmark complete'));});
  else{const p=f.profile,service=await startConfiguredProductService(p.reader,p.policies,p.product,p.options,abort.signal);ready++;await service.close();await p.release();}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(ready,1);assert(f.released);assert.deepEqual(f.transport.stops,[1,1]);assert(f.transport.firmware.every(f=>f.motion.length===0));
 }finally{await f.profile.release();await rm(dir,{recursive:true,force:true});}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallMedianRatio:1.1,wallP95Ratio:1.2,wallSlackMs:10,cpuRatio:1.5,cpuSlackMs:5};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['directServiceLifecycle','processOwnerLifecycle'],timing,cpu:usage,limits,scope:'Native two-UART service startup, HTTP listening, hardware retirement and dependency release. Excludes fixture/profile loading and process launch; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallMedianRatio+limits.wallSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallP95Ratio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
