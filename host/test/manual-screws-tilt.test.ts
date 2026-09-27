import test from 'node:test';
import assert from 'node:assert/strict';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {calculateScrewTilt} from '../src/motion/screws-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
for(const direction of [undefined,'CW','CCW'] as const)test(`manual screw contacts retain configured points and advice direction=${direction}`,async()=>{
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();let p=[0,0,1,0],calls=0,moves=0;
 const points:[[number,number],[number,number],[number,number]]=[[1,1],[2,1],[3,1]];
 const close=registerManualBedTilt(registry,gate,{idle:()=>true,planned:()=>[...p],measured:()=>[...p],limits:{axisMinimum:[0,0,0],axisMaximum:[10,10,10]},move:async next=>{moves++;p=[...next];},apply:async(samples,_,selection)=>{calls++;assert(Object.isFrozen(selection));return calculateScrewTilt(samples.map(p=>p[2]),'CW-M3',selection.direction,selection.maximumDeviation);},synchronize(){},stop:async()=>{},subscribeStop:()=>()=>{}},{points,horizontalHeight:1,travelSpeed:5},300000,'screws_tilt');
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/calibration/screws_tilt/manual',verb,params,{transport:'http',signal:new AbortController().signal,authorize(){}}) as Promise<any>;
 const act=async(action:string,extra:any={})=>invoke('POST',{version:1,state_token:(await invoke('GET')).state_token,action,...extra});
 try{assert.deepEqual((await invoke('GET')).point,[1,1]);await assert.rejects(act('start',{direction:'invalid'}),/direction/);assert.equal(moves,0);await act('start',{...direction?{direction}:{},maximum_deviation:0});assert.equal((await invoke('GET')).maximum_deviation,0);await assert.rejects(act('adjust',{delta:-.1,direction:'CW'}),/Expected/);for(let i=0;i<3;i++){
  assert.deepEqual(p.slice(0,2),points[i]);assert(gate.status.maintenance);await act('adjust',{delta:-.1*(i+1)});const request={version:1,state_token:(await invoke('GET')).state_token,action:'accept'},result=await invoke('POST',request);const count:number=moves;assert.deepEqual(await invoke('POST',request),result);assert.equal(moves,count);assert.equal(calls,i===2?1:0);
 }
 const result=await invoke('GET');assert.equal(result.state,'completed');assert.deepEqual(result.result.results.map((r:any)=>r.adjust),direction==='CCW'?['00:24','00:12','00:00']:['00:00','00:12','00:24']);assert.equal(result.result.error,true);assert.equal(result.result.base,direction==='CCW'?2:0);assert.equal(p[2],1);assert(!gate.status.maintenance);
 }finally{await close();}
});
