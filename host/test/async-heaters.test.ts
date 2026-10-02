import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
const signal=()=>new AbortController().signal,flush=()=>new Promise(resolve=>setImmediate(resolve));
test('target batch validates every entry before one motion barrier and cannot heat after turn off',async()=>{
 const a=heater(),b=heater(),gate=Promise.withResolvers<void>();let barriers=0;
 const group=new AsyncPrinterHeaters(()=>{barriers++;return gate.promise;});group.register('a',a.runtime);group.register('b',b.runtime);await group.start();
 try{
  await assert.rejects(group.setTargets([{name:'a',target:200},{name:'b',target:400}],signal()),/range/);assert.equal(barriers,0);assert.equal(a.runtime.status.target,0);
  await assert.rejects(group.setTargets([{name:'a',target:200},{name:'a',target:100}],signal()),/batch/);assert.equal(barriers,0);
  const pending=group.setTargets([{name:'a',target:200},{name:'b',target:60}],signal()),failed=assert.rejects(pending,/invalidated/);assert.equal(barriers,1);
  const off=group.turnOffAll();gate.resolve();await failed;a.resets[1].resolve();b.resets[1].resolve();await off;assert.equal(a.runtime.status.target,0);assert.equal(b.runtime.status.target,0);
 }finally{gate.resolve();await group.shutdown();}
});
function heater(options:{startup?:boolean;stop?:boolean}={}){
 const resets:ReturnType<typeof Promise.withResolvers<void>>[]=[],stop=Promise.withResolvers<void>();let stops=0;
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset(){const job=Promise.withResolvers<void>();resets.push(job);if(resets.length===1&&!options.startup)job.resolve();return job.promise;},setPWM:async()=>{},stop(reason){stops++;for(const reset of resets)reset.reject(reason);if(!options.stop)stop.resolve();return stop.promise;}},()=>({system:1,print:1}),{},()=>()=>{});
 return {runtime,resets,stop,get stops(){return stops;}};
}
test('group start waits for every reset ACK and locks registration during startup',async()=>{
 const a=heater({startup:true}),b=heater({startup:true}),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime,'A');group.register('b',b.runtime,'B');
 const starting=group.start();assert.equal(group.status.started,false);assert.equal(group.report(),'T:0');assert.throws(()=>group.register('c',heater().runtime));await assert.rejects(group.start(),/restart/);
 a.resets[0].resolve();await flush();assert.equal(b.resets.length,1);assert.equal(group.status.started,false);b.resets[0].resolve();await starting;assert.equal(group.status.started,true);await group.shutdown();
});
test('TURN_OFF_HEATERS sends no acknowledgement until all heaters confirm and coalesces calls',async()=>{
 const a=heater(),b=heater(),group=new AsyncPrinterHeaters(()=>{}),lines:string[]=[];group.register('extruder',a.runtime,'T');group.register('heater_bed',b.runtime,'B');
 const dispatch=new GCodeDispatch({output:line=>lines.push(line),shutdown:reason=>{void group.shutdown(reason).catch(()=>{});}});group.attach(dispatch,{bed:'heater_bed',extruders:['extruder']});await group.start();a.runtime.sample(1,200);b.runtime.sample(1,25);dispatch.setReady(true);
 await dispatch.execute('M104 S220\nM140 S60');const off=dispatch.execute('TURN_OFF_HEATERS',{acknowledge:true});await flush();
 assert.equal(group.status.turningOff,true);assert.equal(a.runtime.status.target,0);assert.equal(b.runtime.status.target,0);assert.deepEqual(lines,[]);
 const joined=group.turnOffAll();assert.equal(joined,group.turnOffAll());await assert.rejects(group.setTarget('extruder',200,signal()),/not active/);
 a.resets[1].resolve();await flush();assert.deepEqual(lines,[]);b.resets[1].resolve();await off;await joined;assert.deepEqual(lines,['ok']);assert.equal(group.status.turningOff,false);
 await group.setTarget('extruder',210,signal());assert.equal(a.runtime.status.target,210);await group.shutdown();
});
test('off invalidates target waiting for motion ordering and cancels temperature waits',async()=>{
 const barrier=Promise.withResolvers<void>(),a=heater(),group=new AsyncPrinterHeaters(()=>barrier.promise);group.register('a',a.runtime);await group.start();a.runtime.sample(1,25);
 const target=group.setTarget('a',200,signal()),targetRejected=assert.rejects(target,/invalidated/);
 const waiting=group.wait('a',100,undefined,signal()),waitRejected=assert.rejects(waiting,/turn off/);
 const off=group.turnOffAll();barrier.resolve();await targetRejected;await waitRejected;a.resets[1].resolve();await off;assert.equal(a.runtime.status.target,0);await group.shutdown();
});
test('group shutdown fences all heaters immediately but waits for every independent stop',async()=>{
 const a=heater({stop:true}),b=heater({stop:true}),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime);group.register('b',b.runtime);await group.start();
 const stopping=group.shutdown('fault');assert.equal(stopping,group.shutdown('later'));assert.equal(group.status.closed,true);assert.equal(group.status.stopConfirmed,false);assert.equal(a.stops,1);assert.equal(b.stops,1);
 a.stop.resolve();await flush();assert.equal(group.status.stopConfirmed,false);b.stop.resolve();await stopping;assert.equal(group.status.stopConfirmed,true);assert.equal(group.status.fault,'fault');
});
test('one runtime fault stops siblings and dispatcher, retaining independent stop failure',async()=>{
 const a=heater(),b=heater({stop:true}),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime);group.register('b',b.runtime);let emergencies=0;
 const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{emergencies++;void group.shutdown(reason).catch(()=>{});}});group.attach(dispatch);await group.start();dispatch.setReady(true);
 const fault=a.runtime.shutdown(new Error('sensor failed'));assert.equal(group.status.closed,true);assert.equal(b.stops,1);assert.equal(emergencies,1);await fault;
 b.stop.reject(new Error('independent stop failed'));await assert.rejects(group.shutdown(),AggregateError);assert.equal(group.status.stopConfirmed,false);assert.ok(group.status.shutdownErrors.length>0);await assert.rejects(dispatch.execute('SET_HEATER_TEMPERATURE HEATER=a TARGET=200'));
});
test('off joins an already pending zero target without repeating reset',async()=>{
 const a=heater(),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime);await group.start();a.runtime.sample(1,25);
 const zero=group.setTarget('a',0,signal());await flush();const off=group.turnOffAll();assert.equal(a.resets.length,2);a.resets[1].resolve();await zero;await off;assert.equal(group.status.closed,false);await group.shutdown();
});
test('stop during startup prevents late activation and restart',async()=>{
 const a=heater({startup:true}),b=heater(),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime);group.register('b',b.runtime);
 const starting=group.start(),rejected=assert.rejects(starting);await group.turnOffAll();await rejected;assert.equal(group.status.started,false);assert.equal(b.runtime.status.started,false);assert.equal(b.stops,1);await assert.rejects(group.start());
});
test('failed off confirmation stops every heater and rejects only after safety stop settles',async()=>{
 const a=heater({stop:true}),b=heater({stop:true}),group=new AsyncPrinterHeaters(()=>{});group.register('a',a.runtime);group.register('b',b.runtime);await group.start();a.runtime.sample(1,25);b.runtime.sample(1,25);
 const off=group.turnOffAll(),rejected=assert.rejects(off,AggregateError);a.resets[1].reject(new Error('reset ACK failed'));await flush();assert.equal(group.status.closed,true);assert.equal(a.stops,1);assert.equal(b.stops,1);assert.equal(group.status.stopConfirmed,false);
 a.stop.resolve();b.stop.resolve();await rejected;assert.equal(group.status.stopConfirmed,true);assert.equal(group.status.turningOff,false);
});
test('M104 zero and M190 zero await device reset instead of reporting early success',async()=>{
 for(const command of ['M104 S0','M190 S0']){
  const a=heater(),group=new AsyncPrinterHeaters(()=>{}),lines:string[]=[];group.register('a',a.runtime);const dispatch=new GCodeDispatch({output:line=>lines.push(line),shutdown:reason=>{void group.shutdown(reason).catch(()=>{});}});group.attach(dispatch,{bed:'a',extruders:['a']});await group.start();dispatch.setReady(true);
  const pending=dispatch.execute(command,{acknowledge:true});await flush();assert.deepEqual(lines,[]);a.resets[1].resolve();await pending;assert.deepEqual(lines,['ok']);await group.shutdown();
 }
});
