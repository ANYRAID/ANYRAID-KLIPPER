import test from'node:test';import assert from'node:assert/strict';
import{GCodeDispatch}from'../src/gcode/dispatch.ts';import{MaintenanceGate}from'../src/operations/maintenance-gate.ts';import{registerNativeDriverCurrent}from'../src/moonraker/native-driver-current.ts';import{EndpointRegistry}from'../src/moonraker/endpoints.ts';import{ApiError,JsonRpcDispatcher,type RpcContext}from'../src/moonraker/rpc.ts';
function fixture(){
 const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let clockBusy=false,printing=false,revision=0,run=.8,hold=.3,max=2,writes=0,stops=0,faults=0,failing=false;
 const lane=new GCodeDispatch({output(){},shutdown(){stops++;}});lane.setReady(true);
 const port={snapshot:()=>[{name:'tmc2209 stepper_x',revision,max_current:max,run_current:run,hold_current:hold}],idle:()=>!clockBusy&&!printing,
  canQueue:()=>!printing&&lane.canFollowIdleWork,reserveExclusive:(work:(s:AbortSignal,begin:()=>void)=>Promise<void>,s:AbortSignal)=>lane.runAdmissionExclusive(work,s),
  async set(_name:string,change:{run?:number;hold?:number},s:AbortSignal){assert(!clockBusy&&!printing);s.throwIfAborted();writes++;if(failing)throw Error('synthetic write failure');run=change.run??run;hold=change.hold??hold;revision++;},fail(){faults++;}};
 const close=registerNativeDriverCurrent(registry,gate,port),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>({username:'operator'})};
 const get=()=>registry.invoke('/printer/settings/driver_current','GET',{},context) as Promise<any>;
 const post=(body:any,ctx=context)=>registry.invoke('/printer/settings/driver_current','POST',body,ctx);
 const beginClock=async()=>{const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();const task=lane.runWhenIdle(async()=>{const release=gate.acquire();clockBusy=true;entered.resolve();try{await finish.promise;}finally{clockBusy=false;release();}},new AbortController().signal);await entered.promise;return{finish:()=>finish.resolve(),task};};
 return{gate,lane,context,get,post,beginClock,close,setPrinting(v:boolean){printing=v;},setMax(v:number){max=v;},external(){revision++;},failWrite(){failing=true;},get writes(){return writes;},get stops(){return stops;},get faults(){return faults;}};
}
const request=(s:any)=>({version:1,state_token:s.state_token,driver:'tmc2209 stepper_x',run_current:1,hold_current:.3});
test('current adjustment follows only existing idle clock work and writes once',async()=>{
 const f=fixture(),body=request(await f.get()),clock=await f.beginClock();try{const pending=f.post(body).catch(e=>e);await new Promise(r=>setImmediate(r));assert.equal(f.writes,0);clock.finish();await clock.task;const result=await pending;assert(!(result instanceof Error),String(result));assert.deepEqual(await f.post(body),result);assert.equal(f.writes,1);assert.equal(f.stops,0);assert.equal(f.faults,0);}finally{clock.finish();await clock.task;await f.close();}
});
test('a real print admitted during clock wait blocks current without stopping that owner',async()=>{
 const f=fixture(),body=request(await f.get()),clock=await f.beginClock();try{const pending=f.post(body).catch(e=>e);await new Promise(r=>setImmediate(r));f.setPrinting(true);clock.finish();await clock.task;const result=await pending;assert(result instanceof ApiError&&result.status===409);assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);assert.equal(f.gate.status.closed,false);}finally{clock.finish();await clock.task;await f.close();}
});
test('permission and user identity are rechecked after clock work retires',async()=>{
 for(const changedIdentity of[false,true]){const f=fixture(),body=request(await f.get()),clock=await f.beginClock();let checks=0;try{const pending=f.post(body,{...f.context,authorize(){checks++;if(checks>1){if(changedIdentity)return{username:'other'};throw new ApiError(403,'revoked');}return{username:'operator'};}}).catch(e=>e);await new Promise(r=>setImmediate(r));clock.finish();await clock.task;const result=await pending;assert(result instanceof ApiError&&result.status===403);assert.equal(checks,2);assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);}finally{clock.finish();await clock.task;await f.close();}}
});
test('cancelled and retired queued adjustments never write or stop unrelated hardware',async()=>{
 for(const retired of[false,true]){const f=fixture(),body=request(await f.get()),clock=await f.beginClock(),abort=new AbortController();try{const pending=f.post(body,{...f.context,signal:abort.signal}).catch(e=>e);await new Promise(r=>setImmediate(r));const closing=retired?f.close():undefined;if(!retired)abort.abort(new Error('caller cancelled'));clock.finish();await clock.task;assert(await pending instanceof Error);await closing;assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);assert.equal(f.gate.status.closed,false);}finally{clock.finish();await clock.task;await f.close();}}
});
test('revision and model bounds changing during wait reject the old request',async()=>{
 for(const revision of[false,true]){const f=fixture(),body=request(await f.get()),clock=await f.beginClock();try{const pending=f.post(body).catch(e=>e);await new Promise(r=>setImmediate(r));if(revision)f.external();else f.setMax(.9);clock.finish();await clock.task;const result=await pending;assert(result instanceof ApiError&&result.status===(revision?409:400));assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);}finally{clock.finish();await clock.task;await f.close();}}
});
test('ordinary scripts and unrelated maintenance are not a queue for later current writes',async()=>{
 const f=fixture(),body=request(await f.get()),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>(),action=f.lane.runExclusive(async()=>{entered.resolve();await finish.promise;},new AbortController().signal);await entered.promise;try{await assert.rejects(f.post(body),e=>e instanceof ApiError&&e.status===409);assert.equal(f.writes,0);}finally{finish.resolve();await action;await f.close();}
 const other=fixture();try{const body=request(await other.get()),release=other.gate.acquire();try{await assert.rejects(other.post(body),e=>e instanceof ApiError&&e.status===409);assert.equal(other.writes,0);assert.equal(other.stops,0);}finally{release();}}finally{await other.close();}
});
test('physical write failure retains maintenance invalidation and dispatch emergency stop',async()=>{
 const f=fixture();try{const body=request(await f.get());f.failWrite();await assert.rejects(f.post(body),e=>e instanceof ApiError&&e.status===503);assert.equal(f.writes,1);assert.equal(f.stops,1);assert.equal(f.faults,1);assert.equal(f.gate.status.closed,true);assert.equal(f.gate.status.maintenance,false);}finally{await f.close();}
});
test('original ten-second deadline includes clock wait without admitting any physical write',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),body=request(await f.get()),clock=await f.beginClock();try{const pending=f.post(body).catch(e=>e);await new Promise(r=>setImmediate(r));t.mock.timers.tick(10001);clock.finish();await clock.task;const result=await pending;assert(result instanceof Error&&result.message==='Current adjustment deadline exceeded');assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);}finally{clock.finish();await clock.task;await f.close();}
});
test('closure cancels a hanging authorization callback without admitting late permission',async()=>{
 const f=fixture(),body=request(await f.get()),entered=Promise.withResolvers<void>(),permit=Promise.withResolvers<{username:string}>();let calls=0;const pending=f.post(body,{...f.context,authorize(){if(++calls===1)return{username:'operator'};entered.resolve();return permit.promise;}}).catch(e=>e);await entered.promise;await f.close();assert(await pending instanceof Error);permit.resolve({username:'operator'});await new Promise(r=>setImmediate(r));assert.equal(f.writes,0);assert.equal(f.stops,0);assert.equal(f.faults,0);
});
test('queued payload is immutable and another adjustment cannot share the same write slot',async()=>{
 const f=fixture(),body=request(await f.get()),clock=await f.beginClock();try{const pending=f.post(body);await new Promise(r=>setImmediate(r));assert.equal((await f.get()).available,false);await assert.rejects(f.post(body),e=>e instanceof ApiError&&e.status===409);body.run_current=1.5;clock.finish();await clock.task;const result:any=await pending;assert.equal(result.drivers[0].run_current,1);assert.equal(f.writes,1);}finally{clock.finish();await clock.task;await f.close();}
});
test('exclusive admission cannot be installed without its matching queue owner',()=>{
 for(const extra of[{canQueue:()=>true},{reserveExclusive:async()=>{}}])assert.throws(()=>registerNativeDriverCurrent(new EndpointRegistry(new JsonRpcDispatcher()),new MaintenanceGate(),{snapshot:()=>[],idle:()=>true,async set(){},fail(){},...extra}),TypeError);
});
