import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeDriverCurrent} from '../src/moonraker/native-driver-current.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const path='/printer/settings/driver_current';
function setup(){
 const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 let revision=0,run=.8,hold=.8,idle=true,calls=0,faults=0,work:(signal:AbortSignal)=>Promise<void>=async()=>{};
 const close=registerNativeDriverCurrent(registry,gate,{snapshot:()=>[{name:'tmc2209 stepper_x',revision,run_current:run,hold_current:hold}],idle:()=>idle,async set(_name,change,signal){calls++;await work(signal);signal.throwIfAborted();run=change.run??run;hold=change.hold??hold;revision++;},fail(){faults++;}});
 const invoke=(verb:string,params:any={})=>registry.invoke(path,verb,params,context) as Promise<any>;
 return {gate,registry,context,close,invoke,setIdle(v:boolean){idle=v;},external(){revision++;},setWork(w:typeof work){work=w;},get calls(){return calls;},get faults(){return faults;}};
}
const request=(state:any)=>({version:1,state_token:state.state_token,driver:'tmc2209 stepper_x',run_current:1,hold_current:.3});
test('authorization, validation, exact retry and external revision fences',async()=>{
 const f=setup();try{
  const initial=await f.invoke('GET'),body=request(initial);
  await assert.rejects(f.registry.invoke(path,'POST',body,{...f.context,authorize(){throw new Error('denied');}}),/denied/);
  for(const change of [{run_current:NaN},{run_current:-1},{hold_current:0},{driver:'missing'},{extra:true}])await assert.rejects(f.invoke('POST',{...body,...change}));assert.equal(f.calls,0);
  const receipt=await f.invoke('POST',body);assert.equal(receipt.persisted,false);assert.equal(receipt.drivers[0].run_current,1);assert.deepEqual(await f.invoke('POST',body),receipt);assert.equal(f.calls,1);
  await assert.rejects(f.invoke('POST',{...body,run_current:1.1}),/conflicts/);
  f.external();await assert.rejects(f.invoke('POST',body),/Stale/);await assert.rejects(f.invoke('POST',request(receipt)),/Stale/);
 }finally{await f.close();}
});
test('maintenance excludes print activity and in-flight duplicates do not write',async()=>{
 const f=setup(),releaseWrite=Promise.withResolvers<void>();try{
  const body=request(await f.invoke('GET'));f.setIdle(false);await assert.rejects(f.invoke('POST',body),/idle/);f.setIdle(true);
  const release=f.gate.activity();await assert.rejects(f.invoke('POST',body),/idle/);release();
  f.setWork(()=>releaseWrite.promise);const pending=f.invoke('POST',body);await new Promise(r=>setImmediate(r));assert.throws(()=>f.gate.activity());assert.equal((await f.invoke('GET')).available,false);
  await assert.rejects(f.invoke('POST',body),/idle/);assert.equal(f.calls,1);releaseWrite.resolve();await pending;assert.equal(f.gate.available,true);
 }finally{releaseWrite.resolve();await f.close();}
});
test('close aborts and joins active writes, failure invalidates admission and redacts causes',async()=>{
 const f=setup();f.setWork(s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(new Error('private device path')),{once:true})));
 const body=request(await f.invoke('GET')),pending=f.invoke('POST',body),rejected=assert.rejects(pending,e=>e instanceof Error&&e.message==='Driver current adjustment failed; reinitialize required');
 await new Promise(r=>setImmediate(r));await f.close();await rejected;assert.equal(f.faults,1);assert.equal(f.gate.status.closed,true);assert.equal(f.gate.status.maintenance,false);
});
test('authorization completing after disposal cannot mutate a retired generation',async()=>{
 const f=setup(),authorized=Promise.withResolvers<void>(),body=request(await f.invoke('GET'));
 const pending=f.registry.invoke(path,'POST',body,{...f.context,authorize:()=>authorized.promise});
 await f.close();authorized.resolve();await assert.rejects(pending,/unavailable/);assert.equal(f.calls,0);
});
test('invalidated hardware cannot return a successful retry receipt',async()=>{
 const f=setup();try{const body=request(await f.invoke('GET'));await f.invoke('POST',body);f.gate.invalidate();await assert.rejects(f.invoke('POST',body),/unavailable/);assert.equal(f.calls,1);}finally{await f.close();}
});
