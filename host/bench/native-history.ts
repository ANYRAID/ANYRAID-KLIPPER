import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePrintUploads} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {registerNativeHistory} from '../src/moonraker/native-history.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
const dir=await mkdtemp(join(tmpdir(),'history-bench-')),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'bench'}),gate=new MaintenanceGate(),controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),files=await PublishedPrintFiles.open(join(dir,'files')),uploads=new NativePrintUploads(files,gate,{stagingRoot:dir}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),release=registerNativeHistory(registry,controller,uploads),network=new MoonrakerNetwork(rpc,{endpoints:registry,authorize(){}});
try{
 const path=join(dir,'source');await writeFile(path,'G1 X1\n');const source=await open(path,'r');try{await files.publish('file','part.gcode',source,new AbortController().signal);}finally{await source.close();}
 for(let i=0;i<2000;i++){const id='job'+i;await journal.reserve({version:1,requestId:id,fileId:'file',nozzle:0,bed:0});await journal.transition(id,1,'cancelled',{totalDuration:1,printDuration:.5,filamentUsed:2});}
 const {port}=await network.listen(),samples:number[][]=[[],[]];
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){const start=performance.now();for(let i=0;i<20;i++){if(variant){const response=await fetch(`http://127.0.0.1:${port}/server/history/list?limit=50`);assert.equal(response.status,200);const body=await response.json();assert.equal(body.result.count,50);assert(body.result.jobs.every((j:any)=>j.exists&&j.filament_used===2));}else assert.equal((await journal.historyList({limit:50})).length,50);}if(run>=3)samples[variant].push((performance.now()-start)/20);}
 const results=samples.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};});assert(results[1].p95Ms<25);console.log(JSON.stringify({node:process.version,records:2000,pageSize:50,warmups:3,runs:11,iterations:20,variants:['journalRead','authenticatedRouteWithNoopPolicyAndFileChecks'],results,maximumHttpP95Ms:25,scope:'Loopback read-only history including durable queries, existence checks and JSON serialization; not a physical target or old/new paired regression comparison.'}));
}finally{await network.close();release();await controller.retire();await uploads.close();await files.close();await journal.close();await rm(dir,{recursive:true,force:true});}
