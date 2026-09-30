import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
import {HostRecoveryJournal,type RecoveryRecord} from '../src/runtime/host-recovery-journal.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
const root=await mkdtemp(join(tmpdir(),'recovery-retention-bench-')),options={path:join(root,'recovery.db'),deviceId:'bench'},control=new ProductHostControl(),loop=monitorEventLoopDelay({resolution:1});
const admissions:number[]=[],settlements:number[]=[],statuses:number[]=[],counts:number[]=[];
const summary=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length*.5)],p99Ms:sorted[Math.ceil(sorted.length*.99)-1],maxMs:sorted.at(-1)};};
const wait=async()=>{const end=performance.now()+5000;while(control.status.busy){assert(performance.now()<end);await immediate();}};
try{
 const opened=await HostRecoveryJournal.open(options);try{for(let i=0;i<128;i++){const r:RecoveryRecord={request_id:'controlled-'+i,state_token:'old-token',state:'queued',error:null};await opened.journal.save(r);await opened.journal.save({...r,state:'running'});await opened.journal.save({...r,state:'succeeded'});}}finally{await opened.journal.close();}
 await control.configure(options);let actions=0;control.attach(async()=>{actions++;});
 for(let i=0;i<64;i++){await control.requestRestart(undefined,undefined,cb=>cb(true));await wait();}
 await delay(5);loop.enable();const started=performance.now(),cpu=process.cpuUsage();
 // Time only the steady full-capacity case: every admission expires a terminal
 // standard receipt and makes all three durable commits in the SQLite worker.
 for(let i=0;i<1000;i++){
  const begin=performance.now(),admitted=await control.requestRestart(undefined,undefined,cb=>cb(true));admissions.push(performance.now()-begin);await wait();settlements.push(performance.now()-begin);assert.equal(control.operation(admitted.request_id)?.state,'succeeded');
  const query=performance.now();for(let j=0;j<100;j++)assert.equal(control.status.recovery_history.standard_restart.retained,64);statuses.push((performance.now()-query)/100);counts.push(control.status.recovery_history.controlled.retained);
 }
 loop.disable();const durationMs=performance.now()-started,cpuUsage=process.cpuUsage(cpu),history=control.status.recovery_history;
 assert.equal(actions,1064);assert(counts.every(count=>count===128));assert.equal(control.status.storage_failed,false);const size=(await stat(options.path)).size;assert(size<=1024*1024);
 const result={node:process.version,cpu:cpus()[0]?.model,iterations:1000,statusReads:100000,durationMs,durableAdmission:summary(admissions),durableSettlement:summary(settlements),statusRead:summary(statuses),eventLoop:{p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6},cpuUsage,history,databaseBytes:size,scope:'Desktop full-capacity durable control benchmark with no-op reload handler; not MCU reload duration, target-board or physical motion validation.'};
 assert(result.eventLoop.p99Ms<10,JSON.stringify(result));assert(result.durableAdmission.p99Ms<25,JSON.stringify(result));process.stdout.write(JSON.stringify(result)+'\n');
}finally{loop.disable();await control.close();await rm(root,{recursive:true,force:true});}
