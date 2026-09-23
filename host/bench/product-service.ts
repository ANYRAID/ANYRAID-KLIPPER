import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {startProductService,type ProductServiceOptions} from '../src/runtime/product-service.ts';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredPrinterFixture} from '../test/helpers/configured-printer.ts';
import {connectConfiguredPrinter} from '../src/runtime/configured-printer.ts';
import {connectProductPrinter} from '../src/runtime/product-printer.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const limits={wallMedianRatio:1.1,wallP95Ratio:1.2,wallSlackMs:10,cpuMedianRatio:1.5,cpuSlackMs:5};
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){
 const f=await configuredPrinterFixture(false,false),dir=await mkdtemp(join(tmpdir(),'product-bench-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),maintenanceGate=new MaintenanceGate(),product={journal,maintenanceGate,limits:{maxNozzle:300,maxBed:130}};
 const configPath=join(dir,'moonraker.conf');await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');
 const serviceOptions:ProductServiceOptions={configPath,server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}}};
 let server:ConfiguredMoonraker|undefined;
 let printer:Awaited<ReturnType<typeof connectConfiguredPrinter>>|undefined,controller:PrintController|undefined;
 try{
  const used=process.cpuUsage(),start=performance.now();
  if(mode){const owner=await startProductService(f.reader,f.connections,'mcu',f.layout,f.options,product,serviceOptions,f.signal);printer=owner.printer;controller=owner.printer.controller;server=owner.server;}
  else{const owner=await connectProductPrinter(f.reader,f.connections,'mcu',f.layout,f.options,product,f.signal);printer=owner;controller=owner.controller;server=await ConfiguredMoonraker.load(configPath,{...serviceOptions.server,productPrint:controller,maintenanceGate});await server.start();}
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){wall[mode].push(elapsed);cpu[mode].push((usage.user+usage.system)/1000);}
  assert.equal(controller.state,'idle');assert(controller.durable);assert.equal(f.firmware[0].motion.length,0);
 }finally{await server?.close();maintenanceGate.invalidate();await controller?.cancel();await printer?.close();await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=wall.map(stats),usage=cpu.map(stats);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,variants:['explicitService','ownedService'],limits,timing,cpu:usage,scope:'Native connection, durable controller restoration, configuration loading and listener startup; excludes journal open, fixtures, requests, close and physical printing.'}));
assert(timing[1].medianMs<timing[0].medianMs*limits.wallMedianRatio+limits.wallSlackMs);
assert(timing[1].p95Ms<timing[0].p95Ms*limits.wallP95Ratio+limits.wallSlackMs);
assert(usage[1].medianMs<usage[0].medianMs*limits.cpuMedianRatio+limits.cpuSlackMs);
