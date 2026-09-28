import test from 'node:test';
import assert from 'node:assert/strict';
import {TemperatureFanRuntime} from '../src/thermal/temperature-fan-runtime.ts';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(capacity=16,timeout=3){
 let now=1,callback:(()=>void)|undefined,stops=0;const calls:number[][]=[],faults:unknown[]=[];
 const output={configuration:{initialPower:0,defaultPower:1,maximumDuration:0},async reset(){},async setPWM(t:number,p:number,_signal:AbortSignal){calls.push([t,p]);},async stop(){stops++;}};
 const fan=new ScheduledCoolingFan(output,{shutdownPower:1,kickStartTime:.1,minimumScheduleTime:.02,capacity});await fan.start(new AbortController().signal);
 const control=new TemperatureFanControl({minimumTemperature:0,maximumTemperature:100,target:40,minimumSpeed:0,maximumSpeed:.5},{kind:'watermark',delta:2},.3);
 const owner=new TemperatureFanRuntime(fan,control,()=>now,e=>faults.push(e),timeout,{schedule(cb){assert.equal(callback,undefined);callback=cb;return ()=>{callback=undefined;};}});
 owner.start();
 return {owner,control,fan,output,calls,faults,get stops(){return stops;},get scheduled(){return !!callback;},sample(t:number,temp:number){now=t;owner.sample(t,temp);},async tick(t:number){now=t;const cb=callback;assert(cb);callback=undefined;cb();await settle();},setNow(t:number){now=t;}};
}
test('first cold sample authorizes zero; cooling and kick tail run without another sample',async()=>{
 const f=await fixture();await f.tick(1);assert.deepEqual(f.calls,[]);
 f.sample(1.1,20);await f.tick(1.11);assert.deepEqual(f.calls,[[1.4000000000000001,0]]);
 f.sample(1.5,50);await f.tick(1.51);assert.deepEqual(f.calls.at(-1),[1.8,1]);
 await f.tick(1.87);assert.equal(f.calls.at(-1)![1],.5);assert.equal(f.fan.status.pending,0);
 await f.owner.stop();assert.equal(f.stops,1);assert.deepEqual(f.faults,[]);
});
test('every sample updates control once while output writes are serialized',async()=>{
 const f=await fixture(),gate=Promise.withResolvers<void>();f.output.setPWM=async(t,p)=>{f.calls.push([t,p]);await gate.promise;};
 f.sample(1,20);await f.tick(1.01);assert.equal(f.scheduled,true);
 f.sample(1.4,50);assert.equal(f.control.state.temperature,50);assert.equal(f.control.state.time,1.4);
 gate.resolve();await settle();await f.tick(1.41);assert.equal(f.calls.length,2);
 await f.owner.stop();assert.deepEqual(f.faults,[]);
});
test('missing first sample and later stale sensor both restore firmware shutdown policy',async()=>{
 for(const sampled of [false,true]){const f=await fixture();if(sampled){f.sample(1,20);await f.tick(1.01);}
  await f.tick(4.01);assert.equal(f.faults.length,1);assert.match(String(f.faults[0]),/stale/);assert.equal(f.stops,1);assert.equal(f.scheduled,false);await f.owner.stop();}
});
test('slow sensor freshness is independent of the short PWM scheduling delay',async()=>{
 const f=await fixture(16,36);f.sample(1,20);await f.tick(1.01);assert.equal(f.calls[0][0],1.3);
 await f.tick(30);assert.deepEqual(f.faults,[]);f.sample(31,50);await f.tick(31.01);assert.equal(f.calls.at(-1)![0],31.3);
 await f.tick(31.37);await f.tick(67.01);assert.match(String(f.faults[0]),/stale/);assert.equal(f.stops,1);await f.owner.stop();
});
test('late, duplicate and out of range samples stop without adding output',async()=>{
 for(const invalid of [(f:Awaited<ReturnType<typeof fixture>>)=>{f.setNow(2);f.owner.sample(1.1,50);},(f:Awaited<ReturnType<typeof fixture>>)=>f.owner.sample(1,50),(f:Awaited<ReturnType<typeof fixture>>)=>f.owner.sample(1.1,101)]){
  const f=await fixture();f.sample(1,20);await f.tick(1.01);const count=f.calls.length;
  assert.throws(()=>invalid(f));await f.owner.stop();assert.equal(f.calls.length,count);assert.equal(f.faults.length,1);assert.equal(f.stops,1);
 }
});
test('queue capacity and missed output deadline stop instead of dropping control transitions',async()=>{
 const full=await fixture(1);full.sample(1,20);assert.throws(()=>full.sample(1.1,50),/queue/);await full.owner.stop();assert.equal(full.stops,1);
 const late=await fixture();late.sample(1,20);await late.tick(1.4);assert.match(String(late.faults[0]),/deadline/);assert.deepEqual(late.calls,[]);await late.owner.stop();
});
test('close aborts in-flight write and joins settlement without timer resurrection',async()=>{
 const f=await fixture(),gate=Promise.withResolvers<void>();let signal:AbortSignal|undefined;
 f.output.setPWM=async(_t,_p,s)=>{signal=s;await gate.promise;};f.sample(1,20);await f.tick(1.01);
 let done=false;const closed=f.owner.stop().then(()=>{done=true;});await settle();assert.equal(signal?.aborted,true);assert.equal(done,false);
 gate.resolve();await closed;assert.equal(f.scheduled,false);assert.equal(f.stops,1);assert.deepEqual(f.faults,[]);
});
test('freshness watchdog stops a stalled write before it settles',async()=>{
 const f=await fixture(),gate=Promise.withResolvers<void>();let signal:AbortSignal|undefined;
 f.output.setPWM=async(_t,_p,s)=>{signal=s;await gate.promise;};f.sample(1,20);await f.tick(1.01);
 await f.tick(4.01);assert.equal(signal?.aborted,true);assert.equal(f.stops,1);assert.equal(f.scheduled,false);assert.match(String(f.faults[0]),/stale/);
 gate.resolve();await f.owner.stop();assert.equal(f.scheduled,false);
});
test('expired kick tail and backwards clock stop instead of sending past MCU timestamps',async()=>{
 const f=await fixture();f.sample(1,20);await f.tick(1.01);f.sample(1.5,50);await f.tick(1.51);
 await f.tick(2);assert.match(String(f.faults[0]),/kick deadline/);await f.owner.stop();assert.equal(f.calls.length,2);
 const backwards=await fixture();await backwards.tick(.9);assert.match(String(backwards.faults[0]),/clock/);await backwards.owner.stop();
});
