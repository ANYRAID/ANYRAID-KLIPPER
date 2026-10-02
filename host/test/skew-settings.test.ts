import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeSkew} from '../src/moonraker/native-skew.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const profile={xy:.01,xz:.02,yz:.03};
function fixture(){
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let revision=0,factors={xy:0,xz:0,yz:0},calls=0,idle=true,fail=false,stopped=false;
 const close=registerNativeSkew(registry,gate,{saved:profile},{snapshot:()=>({revision:String(revision),factors}),idle:()=>idle,set:async value=>{calls++;if(fail)throw Error('device');factors=value??{xy:0,xz:0,yz:0};revision++;},fail:async()=>{stopped=true;}});
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/settings/skew',verb,params,{transport:'http',signal:new AbortController().signal,authorize(){}}) as Promise<any>;
 return {invoke,close,gate,get calls(){return calls;},get stopped(){return stopped;},edit(){revision++;},busy(){idle=false;},fail(){fail=true;}};
}
test('skew settings validate atomically and fence retries, competing activity and external changes',async()=>{
 const f=fixture();try{
  let token=(await f.invoke('GET')).state_token;const load={version:1,state_token:token,action:'load',profile:'saved'};
  const release=f.gate.activity();await assert.rejects(f.invoke('POST',load),/idle/);release();
  await assert.rejects(f.invoke('POST',{version:1,state_token:token,action:'measure',measurements:{xy:[142,141,100],xz:null,yz:[1,1,2]}}),/geometry/);assert.equal(f.calls,0);
  const value=await f.invoke('POST',load);assert.deepEqual(value.factors,profile);assert.deepEqual(await f.invoke('POST',load),value);assert.equal(f.calls,1);
  await assert.rejects(f.invoke('POST',{version:1,state_token:token,action:'clear'}),/conflicts/);
  f.edit();await assert.rejects(f.invoke('POST',load),/Stale/);
  token=(await f.invoke('GET')).state_token;const measured=await f.invoke('POST',{version:1,state_token:token,action:'measure',measurements:{xy:[Math.SQRT2,Math.SQRT2,1],xz:null,yz:null}});assert.deepEqual(measured.factors,{xy:0,xz:0,yz:0});assert.equal(f.calls,2);assert.equal(f.gate.status.maintenance,false);
  f.busy();await assert.rejects(f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'clear'}),/idle/);
 }finally{await f.close();}
});
test('failed skew application stops hardware and invalidates maintenance generation',async()=>{
 const f=fixture();try{f.fail();await assert.rejects(f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'clear'}),/reinitialize/);assert(f.stopped);assert(f.gate.status.closed);assert.equal(f.gate.status.maintenance,false);}finally{await f.close();}
});
test('closing skew settings aborts and joins an in-flight operation',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let stopped=false,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const close=registerNativeSkew(registry,gate,{}, {snapshot:()=>({revision:'0',factors:{xy:0,xz:0,yz:0}}),idle:()=>true,set:async(_,signal)=>{entered();await new Promise<void>((resolve,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},fail:async()=>{stopped=true;}});
 const context={transport:'http' as const,signal:new AbortController().signal,authorize(){}};
 const snapshot=await registry.invoke('/printer/settings/skew','GET',{},context) as any;
 const pending=registry.invoke('/printer/settings/skew','POST',{version:1,state_token:snapshot.state_token,action:'clear'},context),rejected=assert.rejects(pending,/reinitialize/);
 await ready;await close();await rejected;assert(stopped);assert(gate.status.closed);assert.equal(gate.status.maintenance,false);
});
