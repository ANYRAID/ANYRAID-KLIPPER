import test from 'node:test';
import assert from 'node:assert/strict';
import {HeaterFanRuntime} from '../src/thermal/heater-fan-runtime.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(){
 let callback:(()=>void)|undefined,delay=0,now=1,state={temperature:20,target:0,stale:false},stops=0;const calls:number[][]=[],faults:unknown[]=[];
 const output={configuration:{initialPower:0,defaultPower:1,maximumDuration:0},async reset(){},async setPWM(t:number,p:number){calls.push([t,p]);},async stop(){stops++;}};
 const fan=new ScheduledCoolingFan(output,{shutdownPower:1,kickStartTime:.1,minimumScheduleTime:.02});await fan.start(new AbortController().signal);
 const owner=new HeaterFanRuntime(fan,{heaters:['extruder'],threshold:50,speed:.5},()=>state,()=>now,e=>faults.push(e),{schedule(cb,d){assert.equal(callback,undefined);callback=cb;delay=d;return ()=>{callback=undefined;};}});
 return {owner,fan,output,calls,faults,get stops(){return stops;},get delay(){return delay;},get scheduled(){return !!callback;},setState(s:typeof state){state=s;},async tick(at:number){now=at;const cb=callback;assert(cb);callback=undefined;cb();await settle();}};
}
test('thermal owner turns cold fan off, starts on target, settles kick and cools after target zero',async()=>{
 const f=await fixture();f.owner.start();await f.tick(1);assert.deepEqual(f.calls,[[1.1,0]]);
 f.setState({temperature:20,target:200,stale:false});await f.tick(2);assert.deepEqual(f.calls.at(-1),[2.1,1]);assert(Math.abs(f.delay-.1)<1e-12);
 await f.tick(2.11);assert.deepEqual(f.calls.at(-1),[2.2,.5]);
 f.setState({temperature:80,target:0,stale:false});await f.tick(3.11);assert.equal(f.calls.length,3);
 f.setState({temperature:50,target:0,stale:false});await f.tick(4.11);assert.equal(f.calls.at(-1)![1],0);
 await f.owner.stop();assert.equal(f.scheduled,false);assert.equal(f.stops,1);assert.deepEqual(f.faults,[]);
});
test('closing aborts in-flight output and waits for its settlement without rescheduling',async()=>{
 const f=await fixture(),write=Promise.withResolvers<void>();let aborted=false;
 f.output.setPWM=async()=>{await write.promise;};f.owner.start();await f.tick(1);
 let stopped=false;const stop=f.owner.stop().then(()=>{stopped=true;});await settle();assert.equal(stopped,false);assert.equal(f.fan.status.phase,'stopped');aborted=true;write.resolve();await stop;
 assert(aborted);assert.equal(f.scheduled,false);assert.deepEqual(f.faults,[]);
});
test('invalid temperature faults and stops owner without scheduling more work',async()=>{
 const f=await fixture();f.setState({temperature:NaN,target:0,stale:false});f.owner.start();await f.tick(1);await settle();assert.equal(f.faults.length,1);assert.equal(f.stops,1);assert.equal(f.scheduled,false);await f.owner.stop();
});
