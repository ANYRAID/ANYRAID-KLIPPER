import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {productTransports} from '../test/helpers/product-transports.ts';
import {startProductService,startConfiguredProductService,type ProductServiceOptions} from '../src/runtime/product-service.ts';
import {configuredMCUConnections} from '../src/runtime/configured-mcu-connections.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const limits={wallMedianRatio:1.1,wallP95Ratio:1.2,wallSlackMs:10,cpuMedianRatio:1.5,cpuSlackMs:5},wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await configuredPrinterFixture(false,false),transport=await productTransports(f.reader),dir=await mkdtemp(join(tmpdir(),'configured-product-bench-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),maintenanceGate=new MaintenanceGate(),product={journal,maintenanceGate,limits:{maxNozzle:300,maxBed:130}},configPath=join(dir,'moonraker.conf');
 await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');
 const options:ProductServiceOptions={configPath,server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}}};
 let owner:Awaited<ReturnType<typeof startProductService>>|undefined;
 try{
  const start=performance.now(),used=process.cpuUsage();
  owner=mode?await startConfiguredProductService(transport.reader,transport.policies,product,{...options,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:f.options.hardware,print:f.options.print},f.signal):await startProductService(transport.reader,configuredMCUConnections(transport.reader,transport.policies),'mcu',f.layout,f.options,product,options,f.signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(owner.printer.controller.state,'idle');assert(owner.printer.controller.durable);assert(transport.firmware.every(f=>f.motion.length===0));
 }finally{await owner?.close();await transport.close();await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['preplannedService','configuredService'],limits,timing,cpu:usage,scope:'Real PTY UART acquisition through native hardware, durable controller and HTTP listener startup; excludes fixtures, journal open, close and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallMedianRatio+limits.wallSlackMs);assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallP95Ratio+limits.wallSlackMs);assert(usage[1].medianMs<usage[0].medianMs*limits.cpuMedianRatio+limits.cpuSlackMs);
