import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
import {ThermalPrintDevice} from '../src/operations/thermal-print-device.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const signal=()=>new AbortController().signal,job={version:1 as const,requestId:'multi',fileId:'file',nozzle:200,bed:60};
async function fixture(){
 const heaters=new AsyncPrinterHeaters(()=>{}),names=['extruder','extruder1','heater_bed'],resets=[0,0,0],runtimes:AsyncHeaterRuntime[]=[];
 for(const [i,name] of names.entries()){const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset:async()=>{resets[i]++;},setPWM:async()=>{},stop:async()=>{}},()=>({system:1,print:1}),{},()=>()=>{});heaters.register(name,runtime);runtimes.push(runtime);}
 await heaters.start();runtimes.forEach((r,i)=>r.sample(1,[220,230,80][i]));const events:string[]=[];
 const motion={prepare:async()=>{},start:async()=>{},pause:async()=>{events.push('pause');},resume:async()=>{events.push('resume');},finish:async()=>{events.push('finish');},stop:async()=>{events.push('stop');}};
 const device=new ThermalPrintDevice(motion,heaters,{nozzle:'extruder',bed:'heater_bed',extruders:names.slice(0,2)});
 return {heaters,runtimes,resets,events,device};
}
test('preparation disables inactive hotend; resume waits for file-established targets on both tools',async()=>{
 const f=await fixture();try{
  await f.heaters.setTarget('extruder1',210,signal());await f.device.prepare(job,signal());assert.equal(f.heaters.getTemperature('extruder1').target,0);
  await f.device.start('file',signal());await f.heaters.setTargets([{name:'extruder',target:210},{name:'extruder1',target:220}],signal());await f.device.pause(signal());
  const waited:string[]=[],wait=f.heaters.waitUntilStable.bind(f.heaters),gate=Promise.withResolvers<void>();f.heaters.waitUntilStable=async(name,...args)=>{waited.push(name);await wait(name,...args);if(name==='extruder1')await gate.promise;};
  const resume=f.device.resume(signal());await new Promise(r=>setImmediate(r));assert.deepEqual(new Set(waited),new Set(['extruder','extruder1','heater_bed']));assert(!f.events.includes('resume'));gate.resolve();await resume;assert(f.events.includes('resume'));
  await f.device.finish('multi',signal());for(const name of ['extruder','extruder1','heater_bed'])assert.equal(f.heaters.getTemperature(name).target,0);assert(f.resets.every(n=>n>=2));
 }finally{await f.heaters.shutdown();}
});
test('changing any hotend while paused invalidates thermal readiness without resuming motion',async()=>{
 const f=await fixture();try{await f.device.prepare(job,signal());await f.heaters.setTarget('extruder1',220,signal());await f.device.pause(signal());await f.heaters.setTarget('extruder1',0,signal());await assert.rejects(f.device.resume(signal()),/targets changed/);assert.deepEqual(f.events,['pause']);await f.device.stop();assert(f.events.includes('stop'));assert(f.runtimes.every(r=>r.status.target===0));}finally{await f.heaters.shutdown();}
});
test('standard temperature commands route through current tool or explicit T index',async()=>{
 const f=await fixture();try{let active='extruder1';const dispatch=new GCodeDispatch({output(){},shutdown(){}});f.heaters.attach(dispatch,{bed:'heater_bed',extruders:['extruder','extruder1'],activeExtruder:()=>active});dispatch.setReady(true);
 await dispatch.execute('M104 S210');assert.equal(f.heaters.getTemperature('extruder1').target,210);assert.equal(f.heaters.getTemperature('extruder').target,0);
 await dispatch.execute('M104 T0 S190');assert.equal(f.heaters.getTemperature('extruder').target,190);active='extruder';await dispatch.execute('M104 S200');assert.equal(f.heaters.getTemperature('extruder1').target,210);
 }finally{await f.heaters.shutdown();}
});
