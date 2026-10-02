import test from 'node:test';
import assert from 'node:assert/strict';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {fitBedTilt} from '../src/motion/bed-tilt.ts';
import {planManualProbe} from '../src/homing/manual-probe.ts';
import {setTimeout as delay} from 'node:timers/promises';
const endpoint='/printer/calibration/bed_tilt/manual',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(timeout=300000){
 const gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),moves:number[][]=[];let planned=[0,0,1,0],stops=0,applied=0,blocked=false;
 let onStop:(cause:unknown)=>void=()=>{};const close=registerManualBedTilt(registry,gate,{idle:()=>true,planned:()=>[...planned],measured:()=>planned.map(v=>Math.round(v*100)/100),limits:{axisMinimum:[0,0,0],axisMaximum:[10,10,10]},move:async(p,_speed,s)=>{if(blocked)await new Promise((_,reject)=>{s.throwIfAborted();s.addEventListener('abort',()=>reject(s.reason),{once:true});});s.throwIfAborted();planned=[...p];moves.push([...p]);},apply:async samples=>{applied++;return {...fitBedTilt(samples).adjust};},synchronize(){},stop:async cause=>{stops++;onStop(cause);},subscribeStop:listener=>{onStop=listener;return ()=>{onStop=()=>{};};}},{points:[[0,0],[1,0],[0,1]],horizontalHeight:1,travelSpeed:5},timeout);
 const invoke=(verb:string,body:any={})=>registry.invoke(endpoint,verb,body,context) as Promise<any>;
 const act=async(action:string,extra:Record<string,unknown>={})=>invoke('POST',{version:1,state_token:(await invoke('GET')).state_token,action,...extra});
 return {gate,registry,moves,close,invoke,act,get stops(){return stops;},get applied(){return applied;},block(){blocked=true;},externalStop(){onStop(new Error('MCU fault'));}};
}
test('manual search brackets and moves preserve original bisection and bob constants',()=>{
 assert.deepEqual(planManualProbe(1,[],'bisect_down'),{target:.8,bob:1.3,history:[1]});
 assert.equal(planManualProbe(.9,[1,.8],'bisect_up').target,.95);assert.equal(planManualProbe(.9,[1,.8],'previous_down').target,.8);
 assert.throws(()=>planManualProbe(1,[],0));assert.throws(()=>planManualProbe(1,[],6));assert.throws(()=>planManualProbe(1,[],NaN));
});
test('manual workflow retains the lease, resolves sub-step moves, rejects replays and publishes only after all points',async()=>{
 const f=fixture();try{
  const start={version:1,state_token:(await f.invoke('GET')).state_token,action:'start'};
  await assert.rejects(f.registry.invoke(endpoint,'POST',start,{...context,authorize(){throw Error('denied');}}),/denied/);assert.equal(f.moves.length,0);
  const first=await f.invoke('POST',start);assert.equal(first.state,'awaiting');assert(f.gate.status.maintenance);assert.throws(()=>f.gate.activity());const count=f.moves.length;assert.deepEqual(await f.invoke('POST',start),first);assert.equal(f.moves.length,count);await assert.rejects(f.invoke('POST',{...start,action:'accept'}),/conflicts/);
  await assert.rejects(f.act('accept'),/Lower/);await assert.rejects(f.act('adjust',{delta:6}),/Invalid/);assert.equal(f.moves.length,count);
  const small=await f.act('adjust',{delta:-.001});assert.equal(small.unchanged,true);assert.equal(small.position[2],1);await assert.rejects(f.act('accept'),/Lower/);
  await f.act('adjust',{delta:-.1});assert.equal((await f.invoke('GET')).position[2],.9);assert.equal(f.applied,0);
  for(let point=0;point<3;point++){if(point)await f.act('adjust',{delta:-.1});const result=await f.act('accept');assert.equal(result.accepted.length,point+1);assert.equal(f.applied,point===2?1:0);}
  const completed=await f.invoke('GET');assert.equal(completed.state,'completed');assert(Math.abs(completed.result.x)<1e-14);assert(Math.abs(completed.result.y)<1e-14);assert(Math.abs(completed.result.z-.9)<1e-14);assert.equal(f.gate.status.maintenance,false);assert.equal(f.stops,0);assert.equal(f.moves.at(-1)![2],1);
 }finally{await f.close();}
});
test('cancel interrupts a pending move, stays idempotent and cannot publish a late calibration',async()=>{
 const f=fixture();try{
  await f.act('start');f.block();const token=(await f.invoke('GET')).state_token,pending=f.invoke('POST',{version:1,state_token:token,action:'adjust',delta:-.1}),rejected=assert.rejects(pending,/stopped/);await delay(0);
  const request={version:1,state_token:token,action:'cancel'},cancelled=await f.invoke('POST',request);await rejected;assert.equal(cancelled.state,'cancelled');assert.deepEqual(await f.invoke('POST',request),cancelled);assert.equal(f.applied,0);assert.equal(f.stops,1);assert(f.gate.status.closed);assert.equal(f.gate.status.maintenance,false);
 }finally{await f.close();}
});
for(const mode of ['timeout','hardware','close'] as const)test(`manual waiting session terminates on ${mode}`,async()=>{
 const f=fixture(mode==='timeout'?30:300000);try{
  const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'start'};await f.invoke('POST',request);
  if(mode==='timeout')await delay(60);else if(mode==='hardware'){f.externalStop();await delay(0);}else await f.close();
  assert.equal(f.stops,1);assert.equal(f.applied,0);assert(f.gate.status.closed);assert.equal(f.gate.status.maintenance,false);
  if(mode!=='close'){assert.equal((await f.invoke('GET')).state,'failed');await assert.rejects(f.invoke('POST',request),/Stale/);}
 }finally{await f.close();}
});
test('manual target arithmetic matches original Python fixed reference without rounding',async()=>{
 const {readFileSync}=await import('node:fs');const reference=JSON.parse(readFileSync(new URL('../contracts/manual-probe-reference.json',import.meta.url),'utf8'));
 for(const r of reference.rows){const actual=planManualProbe(r.position,r.history,r.request);assert.equal(actual.target,r.target);assert.equal(actual.bob,r.bob);assert.deepEqual(actual.history,r.past);assert.deepEqual(r.position<actual.bob?[actual.bob,actual.target]:[actual.target],r.moves);}
});
