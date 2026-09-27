import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {ThermalPrintDevice} from '../src/operations/thermal-print-device.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const request={version:1 as const,requestId:'job',fileId:'file',nozzle:200,bed:60};
async function fixture(){
 const group=new AsyncPrinterHeaters(()=>{}),resets:ReturnType<typeof Promise.withResolvers<void>>[][]=[[],[]],runtimes:AsyncHeaterRuntime[]=[];
 for(const [i,name] of ['extruder','bed'].entries()){
  const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset(){const job=Promise.withResolvers<void>();resets[i].push(job);if(resets[i].length===1)job.resolve();return job.promise;},setPWM:async()=>{},stop:async reason=>{for(const job of resets[i])job.reject(reason);}},()=>({system:1,print:1}),{},()=>()=>{});
  group.register(name,runtime);runtimes.push(runtime);
 }
 await group.start();runtimes[0].sample(1,220);runtimes[1].sample(1,80);
 const events:string[]=[],drain=Promise.withResolvers<void>(),motionStop=Promise.withResolvers<void>();
 let motionFault:(cause:unknown)=>void=()=>{};
 const motion:PrintDevice={subscribeFault(listener){motionFault=listener;return ()=>{};},prepare:async()=>{events.push('prepare');},start:async()=>{events.push('start');},pause:async()=>{events.push('pause');},resume:async()=>{events.push('resume');},finish:async()=>{events.push('drain');await drain.promise;events.push('drained');},stop:async()=>{events.push('stop');await motionStop.promise;}};
 const device=new ThermalPrintDevice(motion,group,{nozzle:'extruder',bed:'bed'}),controller=new PrintController(device,{maxNozzle:300,maxBed:130});
 return {group,resets,runtimes,events,drain,motionStop,motion,device,controller,faultMotion(cause:unknown){motionFault(cause);}};
}
test('completion drains motion before resetting heaters and waits for both ACKs',async()=>{
 const f=await fixture();await f.controller.start(request);assert.equal(f.controller.state,'printing');assert.deepEqual(f.events,['prepare','start']);
 const finish=f.controller.complete('job');await flush();assert.equal(f.controller.state,'finishing');assert.equal(f.resets[0].length,1);
 f.drain.resolve();await flush();assert.equal(f.resets[0].length,2);assert.equal(f.resets[1].length,2);assert.equal(f.controller.state,'finishing');
 f.resets[0][1].resolve();await flush();assert.equal(f.controller.state,'finishing');f.resets[1][1].resolve();await finish;assert.equal(f.controller.state,'completed');await f.group.shutdown();
});
test('cancellation starts independent motion and heater stop then waits for all acknowledgements',async()=>{
 const f=await fixture();await f.controller.start(request);const cancel=f.controller.cancel();await flush();assert.equal(f.controller.state,'cancelling');assert.ok(f.events.includes('stop'));assert.equal(f.resets[0].length,2);assert.equal(f.resets[1].length,2);
 f.resets[0][1].resolve();f.resets[1][1].resolve();await flush();assert.equal(f.controller.state,'cancelling');f.motionStop.resolve();await cancel;assert.equal(f.controller.state,'cancelled');await f.group.shutdown();
});
test('late preparation after cancellation cannot start heating or replay a file',async()=>{
 const f=await fixture(),prepare=Promise.withResolvers<void>();f.motion.prepare=async()=>{f.events.push('prepare-held');await prepare.promise;};
 const start=f.controller.start(request),rejected=assert.rejects(start);await flush();const cancel=f.controller.cancel();await flush();f.resets[0][1].resolve();f.resets[1][1].resolve();f.motionStop.resolve();prepare.resolve();await rejected;
 await flush();for(const resets of f.resets)resets.at(-1)!.resolve();await cancel;assert.equal(f.events.includes('start'),false);assert.equal(f.runtimes[0].status.target,0);assert.equal(f.controller.state,'cancelled');await f.group.shutdown();
});
test('heater fault stops motion immediately and permanently rejects new device actions',async()=>{
 const f=await fixture();await f.controller.start(request);const stopped=f.runtimes[0].shutdown(new Error('sensor lost'));assert.ok(f.events.includes('stop'));assert.equal(f.controller.state,'failed');assert.match(String(f.controller.failure),/sensor lost/);f.motionStop.resolve();await stopped;await f.group.shutdown();await f.device.stop();
 await assert.rejects(f.device.resume(new AbortController().signal),/sensor lost/);assert.ok(f.device.status.fault);
});
test('motion stop failure does not skip heater reset and both errors remain visible',async()=>{
 const f=await fixture();await f.controller.start(request);f.motion.stop=async()=>{throw new Error('motion safety failed');};const stop=f.device.stop(),rejected=assert.rejects(stop,AggregateError);assert.equal(f.resets[0].length,2);assert.equal(f.resets[1].length,2);
 f.resets[0][1].resolve();f.resets[1][1].resolve();await rejected;assert.equal(f.runtimes[0].status.target,0);assert.ok(f.device.status.fault);await f.group.shutdown();
});
test('changed heater target during preparation cannot admit file execution',async()=>{
 const f=await fixture(),wait=f.group.waitUntilStable.bind(f.group),signal=new AbortController().signal;
 f.group.waitUntilStable=async(name,local,report)=>{await wait(name,local,report);if(name==='extruder')await f.group.setTarget(name,180,local);};
 await assert.rejects(f.device.prepare(request,signal),/targets changed/);await assert.rejects(f.device.start('file',signal),/prepared/);assert.equal(f.events.includes('start'),false);
 f.motionStop.resolve();await f.group.shutdown();
});
test('latched device fault rejects a new job even after cancellation acknowledges prior work',async()=>{
 const f=await fixture();await f.controller.start(request);f.motionStop.resolve();await f.runtimes[0].shutdown(new Error('fault'));await f.controller.fault(new Error('later'));await f.controller.cancel();
 await assert.rejects(f.controller.start({...request,requestId:'next'}),/reinitialization/);assert.match(String(f.controller.failure),/fault/);
});
test('fault during journal restoration cannot be overwritten by recovered job state',async()=>{
 const gate=Promise.withResolvers<void>();let listener:(cause:unknown)=>void=()=>{},stops=0;
 const device:PrintDevice={subscribeFault(callback){listener=callback;return ()=>{};},prepare:async()=>{},start:async()=>{},pause:async()=>{},resume:async()=>{},finish:async()=>{},stop:async()=>{stops++;}};
 const journal={active:async()=>{await gate.promise;return null;}} as unknown as import('../src/operations/print-journal.ts').PrintJournal;
 const restoring=PrintController.restore(device,{maxNozzle:300,maxBed:130},{},{journal}),rejected=assert.rejects(restoring,/faulted/);
 listener(new Error('device fault during restore'));gate.resolve();await rejected;await flush();assert.equal(stops,1);
});

test('underlying motion fault propagates through thermal adapter and shuts down heating',async()=>{
 const f=await fixture();await f.controller.start(request);const cause=new Error('motion MCU failed');f.faultMotion(cause);
 assert.equal(f.controller.state,'failed');assert.equal(f.controller.failure,cause);assert.equal(f.resets[0].length,2);assert.equal(f.resets[1].length,2);
 f.resets[0][1].resolve();f.resets[1][1].resolve();f.motionStop.resolve();await f.controller.fault(cause);await f.group.shutdown();
});
test('a completed job cannot lend thermal readiness to the next preparing job',async()=>{
 const f=await fixture(),signal=new AbortController().signal,held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let preparing:Promise<void>|undefined;
 try{
  await f.device.prepare(request,signal);await f.device.start('file',signal);f.drain.resolve();
  const finished=f.device.finish('job',signal);await flush();f.resets[0][1].resolve();f.resets[1][1].resolve();await finished;
  const wait=f.group.waitUntilStable.bind(f.group);f.group.waitUntilStable=async(...args)=>{await wait(...args);entered.resolve();await held.promise;};
  preparing=f.device.prepare({...request,requestId:'second',fileId:'next-file'},signal);await entered.promise;
  await assert.rejects(f.device.start('next-file',signal),/prepared/);assert.equal(f.events.filter(e=>e==='start').length,1);
  held.resolve();await preparing;await f.device.start('next-file',signal);assert.equal(f.events.filter(e=>e==='start').length,2);
 }finally{held.resolve();await preparing?.catch(()=>{});f.motionStop.resolve();await f.group.shutdown();}
});
test('requested stop notifications keep cancellation pending until acknowledgements arrive',async()=>{
 const f=await fixture();await f.controller.start(request);await f.controller.pause();const cancelled=f.controller.cancel();await flush();f.faultMotion(new Error('File execution stopped'));assert.equal(f.controller.state,'cancelling');assert.equal(f.controller.failure,undefined);f.resets[0][1].resolve();f.resets[1][1].resolve();f.motionStop.resolve();await cancelled;assert.equal(f.controller.state,'cancelled');await f.group.shutdown();
});
