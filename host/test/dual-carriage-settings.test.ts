import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeDualCarriage} from '../src/moonraker/native-dual-carriage.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
function fixture(){
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();
 let generation={},position=0,calls=0,stops=0,idle=true,invalid=false,fail=false,wait=false;
 const close=registerNativeDualCarriage(registry,gate,{snapshot:()=>({generation,state:{position}}),idle:()=>idle,validate:()=>{if(invalid)throw Error('unhomed');},set:async(_i,_m,s)=>{calls++;if(wait)await new Promise<void>((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));if(fail)throw Error('device');generation={};},fail:async()=>{stops++;}});
 const invoke=(verb:string,params:any={},signal=new AbortController().signal)=>registry.invoke('/printer/settings/dual_carriage',verb,params,{transport:'http',signal,authorize(){}}) as Promise<any>;
 const request=async()=>({version:1,state_token:(await invoke('GET')).state_token,carriage:1,mode:'PRIMARY'});
 return {gate,close,invoke,request,get calls(){return calls;},get stops(){return stops;},edit(){position++;},rebuild(){generation={};},busy(){idle=false;},invalid(){invalid=true;},fail(){fail=true;},wait(){wait=true;}};
}
test('dual carriage receipt is single-use and fenced by physical state and generation',async()=>{
 const f=fixture();try{const request=await f.request(),value=await f.invoke('POST',request);assert.deepEqual(await f.invoke('POST',request),value);assert.equal(f.calls,1);
 await assert.rejects(f.invoke('POST',{...request,mode:'MIRROR'}),/conflicts/);
 f.edit();await assert.rejects(f.invoke('POST',request),/Stale/);
 const next=await f.request();f.rebuild();await assert.rejects(f.invoke('POST',next),/Stale/);assert.equal(f.calls,1);
 }finally{await f.close();}
});
test('schema, busy ownership and unsafe geometry reject without stopping healthy hardware',async()=>{
 const f=fixture();try{const request=await f.request();await assert.rejects(f.invoke('GET',{extra:1}),/parameters/);
 for(const change of [{version:2},{carriage:2},{mode:'bad'},{mode:['PRIMARY']},{extra:1}])await assert.rejects(f.invoke('POST',{...request,...change}),/Expected/);
 const release=f.gate.activity();await assert.rejects(f.invoke('POST',request),/idle/);release();
 f.invalid();await assert.rejects(f.invoke('POST',request),/Unsafe/);assert.equal(f.gate.status.maintenance,false);
 f.busy();await assert.rejects(f.invoke('POST',request),/idle/);assert.equal(f.calls,0);assert.equal(f.stops,0);assert.equal(f.gate.status.closed,false);
 }finally{await f.close();}
});
test('device failure invalidates gate and rejects previous receipts',async()=>{
 const f=fixture();try{const old=await f.request();await f.invoke('POST',old);f.fail();await assert.rejects(f.invoke('POST',await f.request()),/reinitialize/);assert.equal(f.stops,1);await assert.rejects(f.invoke('POST',old),/closed/);}finally{await f.close();}
});
test('shutdown aborts pending change and waits for stop, competing request cannot mutate',async()=>{
 const f=fixture();f.wait();const request=await f.request(),pending=f.invoke('POST',request);const rejected=assert.rejects(pending,/reinitialize/);
 await assert.rejects(f.invoke('POST',request),/idle/);await f.close();await rejected;assert.equal(f.calls,1);assert.equal(f.stops,1);assert.equal(f.gate.status.maintenance,false);
});
