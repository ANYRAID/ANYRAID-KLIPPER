import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativeScrewsTilt} from '../src/moonraker/native-screws-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {calculateScrewTilt} from '../src/motion/screws-tilt.ts';
const endpoint='/printer/calibration/screws_tilt';
test('screw API owns direction, zero tolerance, exclusive measurement and bounded retry receipt',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let calls=0,syncs=0,idle=true;
 const close=registerNativeScrewsTilt(registry,gate,{idle:()=>idle,measure:async(_,direction,limit)=>{calls++;assert(gate.status.maintenance);return calculateScrewTilt([0,.1,.2],'CW-M3',direction,limit);},synchronize:()=>{syncs++;},fail:async()=>{assert.fail('no hardware error');}});
 const context={transport:'http' as const,signal:new AbortController().signal,authorize(){}};
 const invoke=(verb:string,params:any={})=>registry.invoke(endpoint,verb,params,context) as Promise<any>;
 try{
  const request={version:1,state_token:(await invoke('GET')).state_token,direction:'CW',maximum_deviation:0};
  for(const invalid of [{direction:'up'},{maximum_deviation:-1},{maximum_deviation:'0'},{points:[[0,0]]}])await assert.rejects(invoke('POST',{...request,...invalid}));assert.equal(calls,0);
  const release=gate.activity();await assert.rejects(invoke('POST',request),/activity/);release();idle=false;await assert.rejects(invoke('POST',request),/idle/);idle=true;
  const result=await invoke('POST',request);assert.equal(result.result.base,2);assert.equal(result.result.error,true);assert.equal(result.state,'ready');assert.equal(syncs,1);assert.equal(calls,1);assert(!gate.status.closed);
  assert.deepEqual(await invoke('POST',request),result);assert.equal(calls,1);await assert.rejects(invoke('POST',{...request,direction:'CCW'}),/conflicts/);
 }finally{await close();}
});
test('screw API shutdown cancels active probing and stops hardware before close settles',async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let stopped=false,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});
 const close=registerNativeScrewsTilt(registry,gate,{idle:()=>true,measure:async signal=>{entered();return await new Promise((_,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},synchronize:()=>assert.fail('cancelled'),fail:async()=>{stopped=true;}});
 const context={transport:'http' as const,signal:new AbortController().signal,authorize(){}};const state=await registry.invoke(endpoint,'GET',{},context) as any;
 const failed=assert.rejects(registry.invoke(endpoint,'POST',{version:1,state_token:state.state_token},context),/reinitialize/);await ready;await close();await failed;assert(stopped);assert(gate.status.closed);assert(!gate.status.maintenance);
});
