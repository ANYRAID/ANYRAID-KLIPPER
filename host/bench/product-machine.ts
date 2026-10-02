import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
import {loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {runProductHost} from '../src/runtime/product-host.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const dir=await mkdtemp(join(tmpdir(),'machine-bench-')),f=await productMachineFixture(dir),abort=new AbortController();let ready=0;
 try{
  const c=f.config,b=f.bindings,used=process.cpuUsage(),start=performance.now();
  await runProductHost(mode?s=>loadProductMachineProfile(f.path,async()=>b,s):async()=>{
   const reader=new ConfigurationReader(await loadConfiguration(c.printerConfig,{},'printer'),null),journal=await PrintJournal.open({path:c.journalPath,deviceId:c.deviceId});
   return {reader,policies:f.transport.policies,product:{journal,maintenanceGate:new MaintenanceGate(),limits:c.limits},options:{configPath:c.moonrakerConfig,machine:c.machine,hardware:c.hardware,print:{...c.print,...b.print},server:b.server},async release(){await b.release();await journal.close();}};
  },abort.signal,()=>{ready++;abort.abort(new Error('benchmark complete'));});
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(ready,1);assert.equal(f.releases,1);assert.deepEqual(f.transport.stops,[1,1]);assert(f.transport.firmware.every(f=>f.motion.length===0));
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats),limits={wallRatio:1.1,wallSlackMs:10,cpuRatio:1.5,cpuSlackMs:5};
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['manualProfile','declarativeProfile'],timing,cpu:usage,limits,scope:'Configuration/journal acquisition, two-PTY native service startup, retirement and release. Excludes fixture creation, module loading and process launch; no physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallRatio+limits.wallSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallRatio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuRatio+limits.cpuSlackMs);
