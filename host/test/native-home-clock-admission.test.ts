import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {registerNativeProbe} from '../src/moonraker/native-probe.ts';
import {registerProductHostControl} from '../src/moonraker/product-host-api.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {NativeRequestScope} from '../src/moonraker/native-request-scope.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
type AdmissionLane={canFollowIdleWork?:boolean;runAdmissionExclusive?:(work:(signal:AbortSignal,begin:()=>void)=>Promise<void>,signal:AbortSignal)=>Promise<void>};
function fixture(){
 const scope=new NativeRequestScope(),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher(),scope.wrap),control=new ProductHostControl();let busy=false,printing=false,measures=0,stops=0,failMeasure=false;
 const lane=new GCodeDispatch({output(){},shutdown(){stops++;}}),admission=lane as AdmissionLane;lane.setReady(true);
 const motion={
  idle:()=>!printing&&!busy,measure:async()=>{assert(!busy);measures++;if(failMeasure)throw Error('Synthetic physical failure');return {homed_axes:'xyz'};},synchronize(){},
  canQueue:()=>!printing&&admission.canFollowIdleWork===true,
  reserveExclusive:async(work:(signal:AbortSignal,begin:()=>void)=>Promise<void>,signal:AbortSignal)=>{if(!admission.runAdmissionExclusive)throw Error('Missing admission owner');await admission.runAdmissionExclusive(work,signal);}
 };
 const release=registerProductHostControl(registry,control),close=registerNativeProbe(registry,gate,motion,'home');
 const context:RpcContext={transport:'websocket',signal:new AbortController().signal,nativeGenerationSignal:scope.signal,authorize(){return {username:'operator'};}};
 const beginClock=async()=>{const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();const task=lane.runWhenIdle(async()=>{busy=true;entered.resolve();await finish.promise;busy=false;},new AbortController().signal);await entered.promise;return {finish:()=>finish.resolve(),task};};
 return {registry,scope,gate,lane,context,beginClock,get measures(){return measures;},get stops(){return stops;},setPrinting(value:boolean){printing=value;},failMeasure(){failMeasure=true;},closeProbe:close,async close(){release();await close();await scope.drain();await control.close();}};
}
test('standard G28 waits for the existing stationary clock owner, then rechecks and homes once',async()=>{
 const f=fixture(),clock=await f.beginClock();try{
  const request=f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context).catch(error=>error);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.measures,0);clock.finish();await clock.task;
  assert.equal(await request,'ok');assert.equal(f.measures,1);assert.equal(f.stops,0);
 }finally{clock.finish();await clock.task;await f.close();}
});
test('printing admitted while clock retires rejects queued home without stopping the new owner',async()=>{
 const f=fixture(),clock=await f.beginClock();try{
  const request=f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context).catch(error=>error);await new Promise(resolve=>setImmediate(resolve));f.setPrinting(true);clock.finish();await clock.task;
  const result=await request;assert(result instanceof ApiError&&result.status===409);assert.equal(f.measures,0);assert.equal(f.stops,0);assert.equal(f.gate.status.closed,false);
 }finally{clock.finish();await clock.task;await f.close();}
});
test('authority revoked during the existing clock wait is rechecked before physical home',async()=>{
 const f=fixture(),clock=await f.beginClock();let revoked=false,postChecks=0;try{
  const request=f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},{...f.context,authorize(method){if(method==='printer.calibration.post_home'){postChecks++;if(revoked)throw new ApiError(403,'Home denied');}return {username:'operator'};}}).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));revoked=true;clock.finish();await clock.task;const result=await request;
  assert(result instanceof ApiError&&result.status===403);assert.equal(postChecks,2);assert.equal(f.measures,0);assert.equal(f.stops,0);assert.equal(f.gate.status.closed,false);
 }finally{clock.finish();await clock.task;await f.close();}
});
test('cancelled or retired queued homes never run or stop hardware that they did not own',async()=>{
 for(const retired of [false,true]){
  const f=fixture(),clock=await f.beginClock(),cancel=new AbortController();try{
   const request=f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},{...f.context,signal:cancel.signal}).catch(error=>error);await new Promise(resolve=>setImmediate(resolve));
   const closing=retired?f.closeProbe():undefined;if(!retired)cancel.abort(new Error('Caller cancelled'));clock.finish();await clock.task;assert(await request instanceof Error);await closing;
   assert.equal(f.measures,0);assert.equal(f.stops,0);
  }finally{clock.finish();await clock.task;await f.close();}
 }
});
test('a normal machine action is not mistaken for an idle housekeeping worker',async()=>{
 const f=fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>(),action=f.lane.runExclusive(async()=>{entered.resolve();await finish.promise;},new AbortController().signal);await entered.promise;
 try{await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context),error=>error instanceof ApiError&&error.status===409);assert.equal(f.measures,0);assert.equal(f.stops,0);}
 finally{finish.resolve();await action;await f.close();}
});
test('physical home failure still closes maintenance and invokes the dispatch safety stop',async()=>{
 const f=fixture();try{f.failMeasure();await assert.rejects(f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context),error=>error instanceof ApiError&&error.status===503);assert.equal(f.measures,1);assert.equal(f.stops,1);assert.equal(f.gate.status.closed,true);}
 finally{await f.close();}
});
test('exclusive admission checks cannot be installed without their matching queue owner',async()=>{
 const f=fixture();try{
  for(const extra of [{canQueue:()=>true},{reserveExclusive:async()=>{}}])assert.throws(()=>registerNativeProbe(f.registry,f.gate,{idle:()=>true,measure:async()=>({}),synchronize(){},...extra},'home'),TypeError);
 }finally{await f.close();}
});
test('the original 120-second deadline includes waiting for clock ownership, with no physical start',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),clock=await f.beginClock();try{
  const request=f.registry.invoke('/printer/gcode/script','POST',{script:'G28'},f.context).catch(error=>error);await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(120001);clock.finish();await clock.task;
  const result=await request;assert(result instanceof Error&&result.message==='Probe deadline exceeded');assert.equal(f.measures,0);assert.equal(f.stops,0);assert.equal(f.gate.status.closed,false);
 }finally{clock.finish();await clock.task;await f.close();}
});
