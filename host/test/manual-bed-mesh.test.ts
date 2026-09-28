import test from 'node:test';
import assert from 'node:assert/strict';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {planProbeGrid,buildProbeGridMesh} from '../src/homing/probe-grid.ts';
import type {BedMesh} from '../src/motion/bed-mesh.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
function fixture(){
 const plan=planProbeGrid({mesh:{min_x:0,max_x:2,min_y:0,max_y:2,x_count:3,y_count:3,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},horizontalHeight:1,travelSpeed:50},[0,0,0]);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let position=[0,0,1,.5],mesh:BedMesh|undefined,stops=0;
 const close=registerManualBedTilt(registry,gate,{idle:()=>true,planned:()=>position,measured:()=>position,limits:{axisMinimum:[0,0,0],axisMaximum:[10,10,10]},async move(p,_speed,s){s.throwIfAborted();position=[...p];},async apply(samples,s){s.throwIfAborted();mesh=buildProbeGridMesh(plan,samples.map(p=>p[2]));return {persisted:false};},synchronize(){},async stop(){stops++;},subscribeStop(){return ()=>{};}},{points:plan.points.map(p=>[p.nozzleX,p.nozzleY]),horizontalHeight:1,travelSpeed:50},300000,'bed_mesh');
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
