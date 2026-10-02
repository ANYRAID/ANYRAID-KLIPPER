import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl,HeaterPWM} from '../src/thermal/control.ts';
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(sampleTime=1.1){
 let now=1,tick=()=>{},stops=0;const writes:{time:number;power:number}[]=[];
 const control=new BangBangControl(1);let updates=0;const update=control.update.bind(control);control.update=(...args)=>{updates++;return update(...args);};
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3,refreshOutput:true},control,{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},async reset(){},async setPWM(time,power){writes.push({time,power});},async stop(){stops++;}},()=>({system:now,print:now}),{},callback=>{tick=callback;return ()=>{tick=()=>{};};});
 await runtime.start();runtime.sample(1,25);await runtime.setTarget(200);now=sampleTime;runtime.sample(now,25);await settle();
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
test('one-second protection ticks renew a phase-aligned slow sample before the unchanged firmware deadline',async()=>{
 const f=await fixture(1.1000005);
 for(const time of [2.1,3.1,4.100001]){await f.tick(time);assert.equal(f.runtime.status.phase,'active');}
 assert.equal(f.runtime.status.lastTime,1.1000005);assert.equal(f.updates,2);
 assert(f.writes.length>=2);for(let i=1;i<f.writes.length;i++)assert(f.writes[i].time-f.writes[i-1].time<3);
 assert.equal(f.stops,0);await f.runtime.shutdown();assert.equal(f.stops,1);
});
test('pure PWM refresh does not consume or fabricate sample timestamps',()=>{
 const pwm=new HeaterPWM(1,.3);pwm.heartbeat(1);assert.deepEqual(pwm.update(1,1,200),{time:1.3,power:1});assert.equal(pwm.refresh(1.9,200),undefined);
 pwm.heartbeat(3);assert.deepEqual(pwm.refresh(3,200),{time:3.3,power:1});assert.deepEqual(pwm.update(3,0,0),{time:3.3,power:0});assert.equal(pwm.refresh(4,200),undefined);
});
test('slow-source authorization expires on original measurement time while PWM keeps its three-second deadline',async()=>{
 let now=1,tick=()=>{},stops=0;const writes:{time:number;power:number}[]=[];
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3,refreshOutput:true,sampleTimeout:36},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},async reset(){},async setPWM(time,power){writes.push({time,power});},async stop(){stops++;}},()=>({system:now,print:now}),{},cb=>{tick=cb;return ()=>{};});
 runtime.bindSampleRequest(async()=>{now=1.1;runtime.sample(now,197);});await runtime.start();runtime.sample(1,197);await runtime.setTarget(200);await settle();
 for(now=2;now<=37;now++){tick();await settle();assert.equal(runtime.status.phase,'active');}
 assert.equal(runtime.status.lastTime,1.1);assert(writes.length>10);for(let i=1;i<writes.length;i++)assert(writes[i].time-writes[i-1].time<3);
 const count=writes.length;now=38;tick();await settle();assert.equal(runtime.status.phase,'stopped');assert.equal(stops,1);assert.equal(writes.length,count);assert.match(String(runtime.status.cause),/sensor timed out/);
});
test('zero target during requested sampling remains off and rejects concurrent nonzero requests',async()=>{
 let now=1;const gate=Promise.withResolvers<void>();let writes=0;
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3,refreshOutput:true,sampleTimeout:36},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},async reset(){},async setPWM(){writes++;},async stop(){}},()=>({system:now,print:now}),{},()=>()=>{});
 runtime.bindSampleRequest(async()=>{await gate.promise;now=2;runtime.sample(now,25);});await runtime.start();runtime.sample(1,25);const heating=runtime.setTarget(200);await assert.rejects(runtime.setTarget(210),/pending/);await runtime.setTarget(0);gate.resolve();await heating;await settle();assert.equal(runtime.getTemperature().target,0);assert.equal(writes,0);await runtime.shutdown();
});
test('slow but fresh readings cannot bypass failed heating verification',async()=>{
 let now=1,tick=()=>{};
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:100,minimumExtrude:0,smoothTime:1,maxPower:1,reportDelay:.3,refreshOutput:true,sampleTimeout:36},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},async reset(){},async setPWM(){},async stop(){}},()=>({system:now,print:now}),{checkGainTime:36},cb=>{tick=cb;return ()=>{};});
 runtime.bindSampleRequest(async()=>{now=1.1;runtime.sample(now,25);});await runtime.start();runtime.sample(1,25);await runtime.setTarget(40);
 for(now=2;now<=41&&runtime.status.phase==='active';now++){if(now===30)runtime.sample(now,25);tick();await settle();}
 assert.equal(runtime.status.phase,'stopped');assert.equal(runtime.status.lastTime,30);assert.match(String(runtime.status.cause),/not heating/);assert.equal(runtime.getTemperature().target,0);
});
