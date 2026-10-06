import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir,cpus} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
import type {HostRecoveryJournal as Journal,RecoveryRecord,RecoveryKind} from '../src/runtime/host-recovery-journal.ts';
import type {ProductHostControl as Control} from '../src/runtime/product-host-control.ts';
// Optional bundle lets the same measurement compare independently emitted
// baseline and candidate code; no rebuild or dependency install occurs here.
const app=process.argv[2],mode=process.argv[3]??'full';assert(['full','legacy'].includes(mode));
const moduleUrl=(name:string)=>app?pathToFileURL(join(resolve(app),'host/src/runtime',name+'.js')).href:new URL('../src/runtime/'+name+'.ts',import.meta.url).href;
const {HostRecoveryJournal}=await import(moduleUrl('host-recovery-journal')) as {HostRecoveryJournal:typeof Journal};
const {ProductHostControl}=await import(moduleUrl('product-host-control')) as {ProductHostControl:typeof Control};
const kinds:RecoveryKind[]=mode==='legacy'?['restart','firmware_restart']:['restart','firmware_restart','service_start','service_stop','service_restart','server_restart','machine_reboot','machine_shutdown'];
const root=await mkdtemp(join(tmpdir(),'machine-recovery-bench-')),options={path:join(root,'recovery.db'),deviceId:'bench'},control=new ProductHostControl(),loop=monitorEventLoopDelay({resolution:1});
const admissions:number[]=[],settlements:number[]=[],rounds:number[]=[];
const summary=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length*.5)],p99Ms:sorted[Math.ceil(sorted.length*.99)-1],maxMs:sorted.at(-1)};};
const wait=async()=>{const end=performance.now()+5000;while(control.status.busy){assert(performance.now()<end);await immediate();}};
try{
 const opened=await HostRecoveryJournal.open(options);try{
  for(const kind of ['reinitialize',...kinds] as const)for(let i=0;i<(kind==='reinitialize'?128:64);i++){
   const record:RecoveryRecord={request_id:kind+'-'+i,state_token:'seed',state:'queued',error:null,...kind==='reinitialize'?{}:{kind},...kind.startsWith('service_')?{service:'crowsnest'}:{}};
   await opened.journal.save(record);await opened.journal.save({...record,state:'running'});await opened.journal.save({...record,state:'succeeded'});
  }
 }finally{await opened.journal.close();}
 await control.configure(options);let actions=0;control.attach(async()=>{actions++;},()=>{},{kinds});
 // Two unmeasured warmups then eight measured CPU/cache rounds. Include JSON
 // serialization because public status pays for the actual receipt payload.
 for(let round=0;round<10;round++){const samples:number[]=[];for(let i=0;i<1000;i++){const begin=performance.now();for(let j=0;j<50;j++){const status=control.status;assert.equal(status.recovery_history.controlled.retained,128);JSON.stringify(status);}samples.push((performance.now()-begin)/50);}if(round>=2)rounds.push(summary(samples).p99Ms);}
 await delay(5);loop.enable();const started=performance.now(),cpu=process.cpuUsage();
 for(let i=0;i<200;i++){
  const begin=performance.now(),receipt=mode==='legacy'?await control.requestRestart(undefined,undefined,cb=>cb(true)):await control.requestMachineAction({kind:'service',action:(['start','stop','restart'] as const)[i%3],service:'crowsnest'},undefined,undefined,cb=>cb(true));admissions.push(performance.now()-begin);await wait();settlements.push(performance.now()-begin);assert.equal(control.operation(receipt.request_id)?.state,'succeeded');
 }
 loop.disable();const size=(await stat(options.path)).size,result={node:process.version,cpu:cpus()[0]?.model,bundle:app??null,mode,receipts:128+64*kinds.length,statusReads:500000,measuredRounds:8,statusRoundP99Ms:rounds,statusP99MedianMs:summary(rounds).medianMs,actions,durationMs:performance.now()-started,admission:summary(admissions),settlement:summary(settlements),eventLoopP99Ms:loop.percentile(99)/1e6,cpuUsage:process.cpuUsage(cpu),databaseBytes:size,scope:'Desktop durable worker and serialized status CPU benchmark with no-op action owner; not service execution, target-board timing or physical printing.'};
 assert.equal(actions,200);assert.equal(control.status.storage_failed,false);assert(size<=1024*1024);assert(result.statusP99MedianMs<.05,JSON.stringify(result));assert(result.eventLoopP99Ms<10,JSON.stringify(result));assert(result.admission.p99Ms<25,JSON.stringify(result));process.stdout.write(JSON.stringify(result)+'\n');
}finally{loop.disable();await control.close();await rm(root,{recursive:true,force:true});}
