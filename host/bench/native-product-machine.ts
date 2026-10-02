import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {createNativeProductBindings} from '../src/runtime/native-product-machine.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import type {ProductMachineConfiguration} from '../src/config/product-machine.ts';
const root=await mkdtemp(join(tmpdir(),'native-bindings-bench-')),signal=new AbortController().signal;
const config:ProductMachineConfiguration={version:1,deviceId:'bench',printerConfig:join(root,'printer.cfg'),moonrakerConfig:join(root,'moonraker.conf'),journalPath:join(root,'jobs.db'),mcus:{mcu:{transport:'uart',rts:true,leaveBootloader:false}},machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print:{motorCompletion:'hold',startupHoming:{mode:'home',axes:[0,1,2]},parking:{parkXY:[0,0],retract:0,lift:0,travelSpeed:10,liftSpeed:10,retractSpeed:10}},limits:{maxNozzle:300,maxBed:130}};
let direct:PublishedPrintFiles|undefined,bindings:Awaited<ReturnType<typeof createNativeProductBindings>>|undefined;
try{
 const sourcePath=join(root,'source'),content='G1 X1\n'.repeat(8192);await writeFile(sourcePath,content);const source=await open(sourcePath,'r');
 try{for(const name of ['direct','native']){const store=await PublishedPrintFiles.open(join(root,name));try{await store.publish('job','bench.gcode',source,signal);}finally{await store.close();}}}finally{await source.close();}
 direct=await PublishedPrintFiles.open(join(root,'direct'));let authorizations=0;
 bindings=await createNativeProductBindings(config,signal,new MaintenanceGate(),{filesRoot:join(root,'native'),metadataRoot:join(root,'metadata'),createAdapter:async()=>({stops:new Map([['mcu',async()=>{}]]),lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},output(){},async authorizePrintFile(id,s){s.throwIfAborted();assert.equal(id,'job');authorizations++;},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize(){},authorizeNotification(){}},async release(){}})});
 const openers=[()=>direct!.acquire('job',signal),()=>bindings!.print.open('job',signal)],times:number[][]=[[],[]],iterations=50;
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const begin=performance.now();for(let i=0;i<iterations;i++){const reader=await openers[variant]();try{assert.equal(reader.status.size,Buffer.byteLength(content));const batch=(await reader.next(signal))!;assert.equal(batch.script,'G1 X1\n'.repeat(128).slice(0,-1));reader.commit(batch);}finally{await reader.close();}}
  if(run>=3)times[variant].push((performance.now()-begin)*1000/iterations);
 }
 const results=times.map(values=>{values.sort((a,b)=>a-b);return {medianUs:values[5],p95Us:values[10]};});assert.equal(authorizations,14*iterations);
 const addedMedianUs=results[1].medianUs-results[0].medianUs,allowedAddedMedianUs=Math.max(50,results[0].medianUs*.25);
 console.log(JSON.stringify({node:process.version,fileBytes:Buffer.byteLength(content),warmupRuns:3,runs:11,iterations,alternatingOrder:true,variants:['directPublishedStore','nativeMachineAuthorizationAndStore'],results,addedMedianUs,allowedAddedMedianUs,authorizations,scope:'File start: sealed SHA-256 snapshot acquisition, first exact 128-line batch and close. Both independent stores hold identical bytes; no physical motion or steady-state step timing.'}));assert(addedMedianUs<allowedAddedMedianUs,'Native machine file admission regression');
}finally{await bindings?.release();await direct?.close();await rm(root,{recursive:true,force:true});}
