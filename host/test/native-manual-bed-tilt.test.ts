import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
for(const cancel of [false,true])test(`native manual bed tilt uses motor-resolved contact positions (cancel=${cancel})`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,undefined,undefined,undefined,false,undefined,{x_adjust:'.001',z_adjust:'.2'}),s=new AbortController().signal,gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let close:(()=>Promise<void>)|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,0],s);
  close=registerManualBedTilt(registry,gate,{idle:()=>!t.port.status.busy,planned:()=>t.port.homingPosition(),measured:()=>t.port.manualProbePosition(),limits:t.kinematics.status,move:(p,speed,s)=>t.port.homingTravel(p,speed,s),apply:async(samples,s)=>({...await t.port.applyManualBedTilt(samples,s)}),synchronize:()=>t.coordinates.resetPosition(),stop:c=>t.port.motorOff(c),subscribeStop:l=>t.port.subscribeStop(l)},{points:[[50,0],[50.016,0],[50,.016]],horizontalHeight:1,travelSpeed:10});
  const context={transport:'http' as const,signal:s,authorize(){}},path='/printer/calibration/bed_tilt/manual',get=()=>registry.invoke(path,'GET',{},context) as Promise<any>,act=async(action:string,extra:Record<string,number>={})=>registry.invoke(path,'POST',{version:1,state_token:(await get()).state_token,action,...extra},context) as Promise<any>;
  const initial=await act('start');assert.equal(initial.state,'awaiting');assert.equal(t.port.bedTiltStatus!.revision,'0');
  const tiny=await act('adjust',{delta:-1e-6});assert(tiny.unchanged,JSON.stringify({initial,tiny}));assert.equal(tiny.position[2],initial.position[2]);await assert.rejects(act('accept'),/Lower/);
  await act('adjust',{delta:-.100001});const measured=await get();assert.deepEqual(measured.position,t.port.manualProbePosition());assert(Math.abs(measured.position[2]-.9)<.009);assert.notEqual(measured.position[2],t.port.homingPosition()[2]);
  if(cancel){await act('cancel');assert.equal(t.port.bedTiltStatus!.revision,'0');assert.equal(t.kinematics.status.homedAxes,'');assert(t.port.status.failed);}
  else{
   for(let i=0;i<3;i++){if(i)await act('adjust',{delta:-.1});await act('accept');}
   const done=await get();assert.equal(done.state,'completed');assert.equal(done.accepted.length,3);assert.deepEqual(done.result.samples,done.accepted);assert.equal(t.port.bedTiltStatus!.revision,'1');assert.equal(t.kinematics.status.homedAxes,'xyz');assert(!gate.status.maintenance);assert(!t.port.status.failed);assert.equal(t.port.homingPosition()[2],1);
   t.port.move([50,0,.2,0],5);await t.port.drain(s);assert(!t.port.status.failed);
  }
 }finally{await close?.();await t.close();}
});
