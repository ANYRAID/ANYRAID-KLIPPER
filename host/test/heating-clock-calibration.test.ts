import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {withTemperatureCheckpoints} from '../src/thermal/wait-checkpoints.ts';
import {waitForTemperature} from '../src/thermal/temperature-wait.ts';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function clock(){let now=0;const pending=new Set<()=>void>();return {now:()=>now,schedule(callback:()=>void){pending.add(callback);return ()=>{pending.delete(callback);};},advance(time:number){now=time;const due=[...pending];pending.clear();for(const callback of due)callback();},get pending(){return pending.size;}};}
test('temperature success retains active checkpoint ownership without cancelling it',async()=>{
 const c=clock(),ready=Promise.withResolvers<void>(),retired=Promise.withResolvers<void>();let completed=false,calls=0,local:AbortSignal|undefined;
 const pending=withTemperatureCheckpoints(()=>ready.promise,async s=>{calls++;local=s;await retired.promise;},new AbortController().signal,c).then(()=>{completed=true;});
 await flush();c.advance(1);await flush();assert.equal(calls,1);ready.resolve();await flush();assert.equal(completed,false);assert.equal(local!.aborted,false);assert.equal(c.pending,0);
 c.advance(2);assert.equal(calls,1);retired.resolve();await pending;
});
for(const cancel of [false,true])test(`temperature ${cancel?'cancellation':'deadline'} aborts active maintenance but waits for its retirement`,async()=>{
 const c=clock(),external=new AbortController(),retired=Promise.withResolvers<void>();let local:AbortSignal|undefined,settled=false;
 const pending=withTemperatureCheckpoints(s=>waitForTemperature({minimum:100,timeoutSeconds:2,signal:s,read:()=>({temperature:20,target:100,stale:false}),report(){},timer:c}),async s=>{local=s;await retired.promise;},external.signal,c);
 const rejected=assert.rejects(pending,/timed out|cancel heating/).then(()=>{settled=true;});await flush();c.advance(1);await flush();assert(local);
 if(cancel)external.abort(new Error('cancel heating'));else c.advance(2);await flush();assert.equal(local.aborted,true);assert.equal(settled,false);assert.equal(c.pending,0);retired.resolve();await rejected;
});
test('sensor failure starts registry shutdown before an unretired checkpoint can finish',async()=>{
 const c=clock(),retired=Promise.withResolvers<void>(),heaters=new AsyncPrinterHeaters(()=>{},{waitTimer:c});let stale=false,local:AbortSignal|undefined,settled=false;
 heaters.registerSensor('sensor',{getTemperature:()=>({temperature:20,target:0,stale})});await heaters.start();
 const wait=heaters.wait('sensor',100,undefined,new AbortController().signal,()=>{},async s=>{local=s;await retired.promise;}),rejected=assert.rejects(wait).then(()=>{settled=true;});await flush();c.advance(1);await flush();stale=true;c.advance(2);await flush();
 assert.equal(heaters.status.closed,true);assert.equal(local!.aborted,true);assert.equal(settled,false);retired.resolve();await rejected;await heaters.shutdown();
});
test('temperature-only commands cross the motion barrier and fence suffix commands on checkpoint failure',async()=>{
 const c=clock(),heaters=new AsyncPrinterHeaters(()=>{barriers++;},{waitTimer:c});let barriers=0,after=0;
 heaters.registerSensor('sensor',{getTemperature:()=>({temperature:20,target:0,stale:false})});await heaters.start();const dispatch=new GCodeDispatch({output(){},shutdown(){}});
 heaters.attach(dispatch,{},async()=>{throw new Error('checkpoint fault');});dispatch.register('AFTER',()=>{after++;});dispatch.setReady(true);
 const pending=dispatch.execute('TEMPERATURE_WAIT SENSOR=sensor MINIMUM=100\nAFTER'),failed=assert.rejects(pending);await flush();assert.equal(barriers,1);c.advance(1);await failed;assert.equal(after,0);assert.equal(heaters.status.closed,true);assert.equal(c.pending,0);await heaters.shutdown();
});
test('invalid temperature waits reject before any motion barrier or checkpoint',async()=>{
 let barriers=0,checkpoints=0;const heaters=new AsyncPrinterHeaters(()=>{barriers++;}),dispatch=new GCodeDispatch({output(){},shutdown(){}});
 heaters.registerSensor('sensor',{getTemperature:()=>({temperature:20,target:0,stale:false})});await heaters.start();heaters.attach(dispatch,{},async()=>{checkpoints++;});dispatch.setReady(true);
 try{
  for(const command of ['TEMPERATURE_WAIT SENSOR=missing MINIMUM=100','TEMPERATURE_WAIT SENSOR=sensor','TEMPERATURE_WAIT SENSOR=sensor MINIMUM=100 MAXIMUM=50','TEMPERATURE_WAIT SENSOR=sensor MINIMUM=1e999'])await assert.rejects(dispatch.execute(command));
  assert.equal(barriers,0);assert.equal(checkpoints,0);assert.equal(heaters.status.closed,false);
 }finally{await heaters.shutdown();}
});
for(const [command,index,target,temperature] of [['M109',0,230,240],['M190',1,90,100]] as const)test(`${command} keeps MCU calibration active while dispatch owns the heating wait`,async()=>{
 const f=await nativePrintFixture(undefined,false,false,true),owner=await createNativeLinearPrint(f.options);try{
  f.t.kinematics.markHomed([0]);f.gcode.enable();const clock=f.t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline;let finished=false;
  const waiting=f.gcode.dispatch.execute(`${command} S${target}\nG1 X51 F600`).then(()=>{finished=true;});void waiting.catch(()=>{});
  const deadline=performance.now()+8500;while(clock.status.segments<3||f.t.port.status.busy){if(f.t.port.status.failed)throw f.t.port.status.fault;assert(performance.now()<deadline,'heating clock maintenance stalled');await delay(10);}
  assert.equal(finished,false);assert.equal(f.t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);f.runtimes[index].sample(2,temperature);await waiting;
  assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.t.f.stops,0);
 }finally{await owner.close();await f.close();}
});
test('emergency stop during a heating checkpoint stops MCU peers and heater targets before releasing dispatch',async()=>{
 const f=await nativePrintFixture(undefined,false,false,true),owner=await createNativeLinearPrint(f.options);try{
  f.gcode.enable();const pending=f.gcode.dispatch.execute('M109 S230'),failed=assert.rejects(pending);const deadline=performance.now()+4000;
  while(f.t.port.status.phase!=='clock'){assert(performance.now()<deadline);await delay(5);}
  f.gcode.dispatch.emergencyStop('cancel heating checkpoint');await failed;
  assert.equal(f.t.port.status.busy,false);assert.equal(f.t.port.status.failed,true);assert.equal(f.t.f.stops,2);assert.equal(f.runtimes[0].status.target,0);assert.equal(f.runtimes[1].status.target,0);
 }finally{await owner.close();await f.close();}
});
