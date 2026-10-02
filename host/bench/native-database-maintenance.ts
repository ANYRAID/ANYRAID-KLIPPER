import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {statfsSync} from 'node:fs';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {registerDatabaseMaintenance} from '../src/moonraker/database-maintenance.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'native-db-bench-')),gate=new MaintenanceGate(),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'bench'}),database=await DatabaseStore.open({path:join(dir,'active.db'),backupDirectory:join(dir,'backups')});
const noop=async()=>{},controller=new PrintController({prepare:noop,start:noop,pause:noop,resume:noop,finish:noop,stop:noop},{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate});
const context={transport:'http' as const,signal:new AbortController().signal,authorize:()=>{}},standalone=new EndpointRegistry(new JsonRpcDispatcher());
const release=registerDatabaseMaintenance(standalone,database,()=>{assert.equal(controller.state,'idle');},undefined,gate);
let service:ConfiguredMoonraker|undefined;
const operations=10,times:Record<string,number[]>={standaloneBackup:[],nativeBackup:[],standaloneCompact:[],nativeCompact:[]};
try{
 const config=join(dir,'main.conf');await writeFile(config,'[server]\nhost=127.0.0.1\nport=0');service=await ConfiguredMoonraker.load(config,{productPrint:controller,maintenanceGate:gate,database,information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},authorize:()=>{}});
 await database.insertBatch('ui',Object.fromEntries(Array.from({length:200},(_,i)=>['key'+i,'x'.repeat(2048)])));await service.start();
 for(let run=0;run<9;run++)for(const mode of run%2?Object.keys(times).reverse():Object.keys(times)){
  const registry=mode.startsWith('native')?service.endpoints:standalone,route=mode.endsWith('Backup')?'backup':'compact';
  const started=performance.now();for(let i=0;i<operations;i++)await registry.invoke('/server/database/'+route,'POST',route==='backup'?{filename:'snapshot.db'}:{},context);
  if(run>=2)times[mode].push(performance.now()-started);assert.equal(gate.status.maintenance,false);assert.equal(gate.status.closed,false);assert.equal(await database.get('ui','key199'),'x'.repeat(2048));
 }
 await controller.start({version:1,requestId:'after',fileId:'file',nozzle:0,bed:0});await controller.cancel();
 const stats=(samples:number[])=>{samples.sort((a,b)=>a-b);return {medianMs:samples[3],p95Ms:samples[6]};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,operations,warmups:2,runs:7,rows:200,valueBytes:2048,results:Object.fromEntries(Object.entries(times).map(([mode,values])=>[mode,stats(values)])),scope:'Shared gate and real worker SQLite. Standalone guarded maintenance vs configured native endpoint dispatch. Includes worker IPC and local file I/O; no HTTP transport, Python comparison, physical printer, or target flash measurement.'},null,2));
}finally{release();await service?.close();await database.close();await journal.close();await rm(dir,{recursive:true,force:true});}
