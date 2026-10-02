import test from 'node:test';
import assert from 'node:assert/strict';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {planProbeGrid,buildProbeGridMesh} from '../src/homing/probe-grid.ts';
import type {BedMesh} from '../src/motion/bed-mesh.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(dispatch?:GCodeDispatch,clockBusy:()=>boolean=()=>false){
 const plan=planProbeGrid({mesh:{min_x:0,max_x:2,min_y:0,max_y:2,x_count:3,y_count:3,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},horizontalHeight:1,travelSpeed:50},[0,0,0]);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let position=[0,0,1,.5],mesh:BedMesh|undefined,stops=0;
 const close=registerManualBedTilt(registry,gate,{...dispatch?{runExclusive:(work:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal)=>dispatch.runExclusive(work,signal)}:{},idle:()=>!clockBusy(),planned:()=>position,measured:()=>position,limits:{axisMinimum:[0,0,0],axisMaximum:[10,10,10]},async move(p,_speed,s){s.throwIfAborted();if(clockBusy())throw new Error('Native motion port busy or paused');position=[...p];},async apply(samples,s){s.throwIfAborted();mesh=buildProbeGridMesh(plan,samples.map(p=>p[2]));return {persisted:false};},synchronize(){},async stop(){stops++;},subscribeStop(){return ()=>{};}},{points:plan.points.map(p=>[p.nozzleX,p.nozzleY]),horizontalHeight:1,travelSpeed:50},300000,'bed_mesh');
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/calibration/bed_mesh/manual',verb,params,context) as Promise<any>;
 const action=async(action:string,extra:object={})=>invoke('POST',{version:1,state_token:(await invoke('GET')).state_token,action,...extra});
 return {close,gate,invoke,action,get mesh(){return mesh;},get position(){return position;},get stops(){return stops;}};
}
test('manual mesh publishes only after all contacts and preserves snake matrix orientation',async()=>{
 const f=fixture();try{
  await f.action('start');assert(f.gate.status.maintenance);await assert.rejects(f.action('accept'),/Lower/);
  const heights=[.1,.2,.3,.6,.5,.4,.7,.8,.9];for(let i=0;i<9;i++){assert.equal(f.mesh,undefined);await f.action('adjust',{delta:heights[i]-1});const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'accept'},receipt=await f.invoke('POST',request);assert.deepEqual(await f.invoke('POST',request),receipt);}
  assert.equal((await f.invoke('GET')).state,'completed');assert.equal(f.position[3],.5);assert.equal(f.position[2],1);assert.equal(f.gate.status.maintenance,false);
  [...f.mesh!.probedValues()].forEach((v,i)=>assert(Math.abs(v-(i+1)/10)<1e-15));
 }finally{await f.close();}
});
test('cancelled manual mesh never publishes partial calibration',async()=>{
 const f=fixture();try{await f.action('start');await f.action('adjust',{delta:-.2});await f.action('accept');await f.action('cancel');assert.equal(f.mesh,undefined);assert.equal(f.stops,1);assert(f.gate.status.closed);assert.equal((await f.invoke('GET')).state,'cancelled');}finally{await f.close();}
});
test('manual contact joins an admitted clock owner before moving and retains its maintenance lease',async()=>{
 const dispatch=new GCodeDispatch({output(){},shutdown(){}}),signal=new AbortController().signal,release=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let busy=false;
 const f=fixture(dispatch,()=>busy);let clock:Promise<void>|undefined,adjust:Promise<any>|undefined;
 try{
  await f.action('start');const before=[...f.position];
  clock=dispatch.runExclusive(async()=>{busy=true;entered.resolve();await release.promise;busy=false;},signal);await entered.promise;
  adjust=f.action('adjust',{delta:-.2});void adjust.catch(()=>{});await delay(0);
  assert.deepEqual(f.position,before,'No movement while another native owner holds the clock barrier');assert.equal(f.stops,0);assert.equal(f.gate.status.maintenance,true);assert.equal((await f.invoke('GET')).state,'moving');
  await assert.rejects(f.action('adjust',{delta:-.1}),/pending/);
  release.resolve();await clock;const result=await adjust;assert.equal(result.state,'awaiting');assert.equal(f.position[2],.8);assert.equal(f.stops,0);assert.equal(f.gate.status.maintenance,true);
 }finally{release.resolve();await clock;await adjust?.catch(()=>{});await f.close();}
});
test('cancelling a contact queued behind clock maintenance never moves or publishes a late result',async()=>{
 const dispatch=new GCodeDispatch({output(){},shutdown(){}}),signal=new AbortController().signal,release=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let busy=false;
 const f=fixture(dispatch,()=>busy);let clock:Promise<void>|undefined,adjust:Promise<any>|undefined;
 try{
  await f.action('start');const before=[...f.position];clock=dispatch.runExclusive(async()=>{busy=true;entered.resolve();await release.promise;busy=false;},signal);await entered.promise;
  adjust=f.action('adjust',{delta:-.2});void adjust.catch(()=>{});await delay(0);const cancelled=await f.action('cancel');assert.equal(cancelled.state,'cancelled');assert.equal(f.stops,1);assert.equal(f.gate.status.closed,true);
  release.resolve();await clock;await assert.rejects(adjust,/stopped/);assert.deepEqual(f.position,before);assert.equal(f.mesh,undefined);assert.equal(f.stops,1);assert.equal((await f.invoke('GET')).state,'cancelled');
 }finally{release.resolve();await clock;await adjust?.catch(()=>{});await f.close();}
});

test('manual start while clock ownership is busy rejects without stopping or consuming its token',async()=>{
 const dispatch=new GCodeDispatch({output(){},shutdown(){}}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let clockBusy=false;
 const f=fixture(dispatch,()=>clockBusy);
 const clock=dispatch.runWhenIdle(async()=>{clockBusy=true;entered.resolve();await release.promise;clockBusy=false;},new AbortController().signal);
 try{
  await entered.promise;const before=await f.invoke('GET');assert.equal(before.available,false);
  const request={version:1,state_token:before.state_token,action:'start'};
  await assert.rejects(f.invoke('POST',request),/requires idle homed printer/);
  assert.equal(f.stops,0);assert.equal(f.gate.status.maintenance,false);assert.equal(f.gate.status.closed,false);assert.deepEqual(f.position,[0,0,1,.5]);assert.deepEqual(await f.invoke('GET'),before);
  release.resolve();await clock;assert.equal((await f.invoke('GET')).available,true);
  const started=await f.invoke('POST',request);assert.equal(started.state,'awaiting');assert.equal(f.stops,0);assert(f.gate.status.maintenance);
 }finally{release.resolve();await clock;await f.close();}
});
