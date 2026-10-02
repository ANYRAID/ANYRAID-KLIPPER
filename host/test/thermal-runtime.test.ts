import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HeaterRuntime,type HeaterOutput,type ThermalTimer} from '../src/thermal/runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
function setup(options:{gain?:number;output?:Partial<HeaterOutput>}={}) {
 let system=0,print=0,tick=()=>{},cancelled=false;const events:unknown[]=[];
 const schedule:ThermalTimer=fn=>{tick=fn;return ()=>{cancelled=true;};};
 const output:HeaterOutput={configureMaximumDuration:v=>events.push(['duration',v]),schedule:(t,v)=>events.push(['pwm',t,v]),turnOff:()=>events.push(['off']),...options.output};
 const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),output,()=>({system,print}),{checkGainTime:options.gain??20},schedule);
 return {runtime,events,advance:(s:number,p=s)=>{system=s;print=p;tick();},clock:(s:number,p=s)=>{system=s;print=p;},cancelled:()=>cancelled};
}
test('runtime requires fresh data, configures MCU expiry and immediately cancels queued power on off',()=>{
 const {runtime:r,events}=setup();r.start();assert.deepEqual(events,[['duration',3],['off']]);assert.throws(()=>r.setTarget(200));
 r.sample(.1,25);r.setTarget(200);r.sample(.2,25);assert.deepEqual(events.at(-1),['pwm',.5,1]);
 r.setTarget(0);assert.deepEqual(events.at(-1),['off']);r.setTarget(200);r.sample(.3,25);assert.deepEqual(events.at(-1),['pwm',.6,1]);r.shutdown();
});
test('independent protection timer faults missing sensor input without further samples',()=>{
 const {runtime:r,advance,cancelled,events}=setup();r.start();for(let t=1;t<=8;t++)advance(t);
 assert.equal(r.status.stopped,true);assert.match(r.status.fault!,/timed out/);assert.equal(cancelled(),true);assert.deepEqual(events.at(-1),['off']);
});
test('timer stall cannot silently renew heater authorization',()=>{
 const {runtime:r,advance}=setup();r.start();r.sample(.1,200);r.setTarget(220);advance(6);
 assert.match(r.status.fault!,/timer stalled/);assert.equal(r.canExtrude(),false);assert.throws(()=>r.start());
});
test('fresh but nonheating sensor readings trigger verify_heater and stop outputs',()=>{
 const {runtime:r,advance}=setup({gain:1});r.start();r.sample(.1,25);r.setTarget(200);
 for(let t=1;t<=4;t++){r.sample(t,25);advance(t);}
 assert.match(r.status.fault!,/expected rate/);assert.equal(r.status.target,0);assert.throws(()=>r.setTarget(200));
});
test('write and shutdown failures remain visible without re-enabling output',()=>{
 let off=0;const {runtime:r}=setup({output:{schedule:()=>{throw new Error('write failed');},turnOff:()=>{if(++off>1)throw new Error('off failed');}}});
 r.start();r.sample(.1,25);r.setTarget(200);assert.throws(()=>r.sample(.2,25));assert.equal(r.status.stopped,true);assert.match(String(r.status.shutdownError),/off failed/);assert.equal(r.canExtrude(),false);
});
test('sensor out-of-range failures immediately invoke output cancellation',()=>{
 const {runtime:r,events}=setup();r.start();r.sample(.1,200);assert.throws(()=>r.sample(.2,301));assert.deepEqual(events.at(-1),['off']);assert.equal(r.status.target,0);assert.equal(r.canExtrude(),false);
});
test('default Node timer performs independent checks and is cleared on disposal',async()=>{
 let reads=0;const start=performance.now();const r=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configureMaximumDuration:()=>{},schedule:()=>{},turnOff:()=>{}},()=>{reads++;const t=(performance.now()-start)/1000;return {system:t,print:t};});
 try{r.start();await new Promise(resolve=>setTimeout(resolve,1100));assert.ok(reads>=2);assert.equal(r.status.stopped,false);}finally{r.shutdown();}
});
