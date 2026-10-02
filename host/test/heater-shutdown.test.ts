import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HeaterRuntime,type HeaterOutput,type ThermalTimer} from '../src/thermal/runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function fixture(options:{output?:Partial<HeaterOutput>;timer?:ThermalTimer}={}){
 let now=1,tick=()=>{},offs=0;
 const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configureMaximumDuration(){},schedule(){},turnOff(){offs++;},...options.output},()=>({system:now,print:now}),{},options.timer??(callback=>{tick=callback;return ()=>{};}));
 return {runtime,get offs(){return offs;},advance(value:number){now=value;tick();}};
}
test('autonomous heater watchdog fault stops peers, aborts G-code and retains initiating reason',async()=>{
 const first=fixture(),peer=fixture(),group=new PrinterHeaters(()=>{});group.register('first',first.runtime);group.register('peer',peer.runtime);
 let hooks=0;const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{hooks++;group.shutdown(reason);}});group.attach(dispatch);group.start();first.runtime.sample(1,25);peer.runtime.sample(1,25);peer.runtime.setTarget(200);dispatch.setReady(true);
 const pending=dispatch.execute('TEMPERATURE_WAIT SENSOR=first MINIMUM=200');await new Promise(resolve=>setImmediate(resolve));
 first.advance(7);await assert.rejects(pending);
 assert.match(group.status.fault!,/first.*timer stalled/);assert.equal(peer.runtime.status.stopped,true);assert.equal(peer.runtime.status.target,0);assert.equal(hooks,1);
 await assert.rejects(dispatch.execute('SET_HEATER_TEMPERATURE HEATER=peer TARGET=200'));assert.equal(peer.runtime.status.target,0);
});
test('heater subscriptions fan out despite listener errors, replay late and detach idempotently',()=>{
 const f=fixture(),error=new Error('listener failed'),seen:string[]=[];
 f.runtime.subscribeShutdown(()=>{throw error;});const detached=f.runtime.subscribeShutdown(()=>seen.push('detached'));detached();detached();
 f.runtime.subscribeShutdown(reason=>{seen.push(reason);f.runtime.shutdown('secondary');});
 f.runtime.shutdown('primary');assert.deepEqual(seen,['primary']);assert.equal(f.runtime.status.shutdownError,error);assert.equal(f.runtime.status.fault,'primary');
 f.runtime.subscribeShutdown(reason=>seen.push(reason));assert.deepEqual(seen,['primary','primary']);assert.equal(f.offs,1);
});
test('late shutdown listener failures remain visible through registry status',()=>{
 const f=fixture(),group=new PrinterHeaters(()=>{});group.register('heater',f.runtime);group.start();
 const late=new Error('late observer failed');f.runtime.subscribeShutdown(()=>{throw late;});f.runtime.shutdown('sensor failed');
 assert.equal(group.status.closed,true);assert.ok(group.status.shutdownErrors.includes(late));
});
test('reentrant stop during runtime startup cannot publish ready or leak a returned timer',()=>{
 let cancel=0,runtime!:HeaterRuntime;
 const f=fixture({timer(){runtime.shutdown('stopped while arming');return ()=>{cancel++;};}});runtime=f.runtime;
 assert.throws(()=>runtime.start(),/stopped during startup/);assert.equal(cancel,1);assert.equal(runtime.status.stopped,true);
 let configured!:HeaterRuntime;const early=fixture({output:{configureMaximumDuration(){configured.shutdown('configuration stopped');}}});configured=early.runtime;
 assert.throws(()=>configured.start(),/stopped during startup/);assert.equal(configured.status.started,false);
});
test('failed sensor registration removes shutdown subscription and does not close unrelated group',()=>{
 const f=fixture(),group=new PrinterHeaters(()=>{});group.registerSensor('collision',{getTemperature:()=>({temperature:20,target:0,stale:false})});
 assert.throws(()=>group.register('collision',f.runtime));f.runtime.shutdown('not owned');assert.equal(group.status.closed,false);assert.deepEqual(group.status.available_heaters,[]);group.shutdown();
});
test('full subscription capacity rejects registration before changing registry',()=>{
 const f=fixture(),group=new PrinterHeaters(()=>{});for(let i=0;i<64;i++)f.runtime.subscribeShutdown(()=>{});
 assert.throws(()=>group.register('heater',f.runtime));assert.deepEqual(group.status.available_sensors,[]);assert.deepEqual(group.status.available_heaters,[]);f.runtime.shutdown();
});
test('M112 safety hook reentrancy is bounded and an independent repeat still calls safety',()=>{
 const group=new PrinterHeaters(()=>{});let hooks=0;const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{hooks++;group.shutdown(reason);}});group.attach(dispatch);group.start();
 dispatch.emergencyStop();assert.equal(hooks,1);dispatch.emergencyStop();assert.equal(hooks,2);
});
