import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl,HeaterPWM} from '../src/thermal/control.ts';
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(){
 let now=1,tick=()=>{},stops=0;const writes:{time:number;power:number}[]=[];
 const control=new BangBangControl(1);let updates=0;const update=control.update.bind(control);control.update=(...args)=>{updates++;return update(...args);};
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3,refreshOutput:true},control,{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},async reset(){},async setPWM(time,power){writes.push({time,power});},async stop(){stops++;}},()=>({system:now,print:now}),{},callback=>{tick=callback;return ()=>{tick=()=>{};};});
 await runtime.start();runtime.sample(1,25);await runtime.setTarget(200);now=1.1;runtime.sample(now,25);await settle();
 return {runtime,writes,get updates(){return updates;},get stops(){return stops;},async tick(t:number){now=t;tick();await settle();}};
}
test('opt-in heater output renewal preserves sensor timestamp and does not run PID again',async()=>{
 const f=await fixture();assert.equal(f.writes.length,1);
 for(let t=2;t<=8;t++)await f.tick(t);
 assert.equal(f.runtime.status.lastTime,1.1);assert.equal(f.updates,2);assert.equal(f.runtime.status.phase,'active');assert(f.writes.length>=3);
 for(let i=1;i<f.writes.length;i++)assert(f.writes[i].time-f.writes[i-1].time<3);
 const before=f.writes.length;await f.tick(9);assert.equal(f.runtime.status.phase,'stopped');assert.match(String(f.runtime.status.cause),/sensor timed out/);assert.equal(f.writes.length,before);assert.equal(f.stops,1);
});
test('output renewal stops on target zero and never energizes from a cached reading alone',async()=>{
 const f=await fixture();await f.runtime.setTarget(0);const count=f.writes.length;
 await f.tick(2);await f.tick(3);assert.equal(f.writes.length,count);await f.runtime.setTarget(200);await f.tick(4);assert.equal(f.writes.length,count);await f.runtime.shutdown();
});
test('missed firmware refresh deadline stops instead of rescheduling obsolete power',async()=>{
 const f=await fixture();await f.tick(4.2);assert.equal(f.runtime.status.phase,'stopped');assert.match(String(f.runtime.status.cause),/refresh deadline/);assert.equal(f.writes.length,1);assert.equal(f.stops,1);
});
test('pure PWM refresh does not consume or fabricate sample timestamps',()=>{
 const pwm=new HeaterPWM(1,.3);pwm.heartbeat(1);assert.deepEqual(pwm.update(1,1,200),{time:1.3,power:1});assert.equal(pwm.refresh(2,200),undefined);
 pwm.heartbeat(3);assert.deepEqual(pwm.refresh(3,200),{time:3.3,power:1});assert.deepEqual(pwm.update(3,0,0),{time:3.3,power:0});assert.equal(pwm.refresh(4,200),undefined);
});
