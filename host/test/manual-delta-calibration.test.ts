import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {registerManualBedTilt} from '../src/moonraker/native-manual-bed-tilt.ts';
import {registerNativeDeltaCalibration} from '../src/moonraker/native-delta-calibration.ts';
import {DeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {asymmetricDeltaCalibration} from './helpers/delta-calibration.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
async function fixture(){
 const dir=await mkdtemp('/tmp/manual-delta-'),path=dir+'/printer.cfg';await writeFile(path,'[printer]\nkinematics: delta\ndelta_radius: 100\n[delta_calibrate]\nradius: 65\n');
 const {session}=await KlipperSaveSession.load(path),registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate(),input=asymmetricDeltaCalibration()[0],cal=new DeltaCalibration(input.geometry);
 let planned=[0,0,1,.5],stops=0,applied=0;const moves:number[][]=[];
 const owner=registerNativeDeltaCalibration(registry,gate,{canProbe:false,idle:()=>true,async measure(){throw Error('No probe');},synchronize(){}},session);
 const points=input.probes.map(p=>{const xyz=cal.position(p.stable);return [xyz[0],xyz[1]] as [number,number];});
 const closeManual=registerManualBedTilt(registry,gate,{idle:()=>true,planned:()=>planned,measured:()=>planned,limits:{axisMinimum:[-100,-100,0],axisMaximum:[100,100,300]},async move(p,_speed,s){s.throwIfAborted();planned=[...p];moves.push([...p]);},async apply(samples,s){applied++;return owner.acceptManual({...input,probes:samples.map(p=>({height:0,stable:cal.stable([p[0],p[1],p[2]])}))},s);},synchronize(){},async stop(){stops++;},subscribeStop(){return ()=>{};}},{points,horizontalHeight:1,travelSpeed:50},300000,'delta');
 const invoke=(path:string,verb:string,params:any={})=>registry.invoke('/printer/calibration/delta'+path,verb,params,context) as Promise<any>;
 const action=async(action:string,extra:any={})=>invoke('/manual','POST',{version:1,state_token:(await invoke('/manual','GET')).state_token,action,...extra});
 return {invoke,action,path,gate,moves,get applied(){return applied;},get stops(){return stops;},async close(){await Promise.all([closeManual(),owner()]);await rm(dir,{recursive:true,force:true});}};
}
test('manual Delta confirms seven contacts before fitting and explicitly saving',async()=>{
 const f=await fixture();try{
  const original=await f.invoke('','GET');assert.equal(original.automatic,false);await assert.rejects(f.invoke('','POST',{version:1,state_token:original.state_token,action:'calibrate'}),/manual/);
  await f.action('start');assert(f.gate.status.maintenance);assert.equal(f.applied,0);
  await assert.rejects(f.invoke('','POST',{version:1,state_token:original.state_token,action:'save'}),/candidate/);
  for(let i=0;i<7;i++){
   await f.action('adjust',{delta:-.8});const token=(await f.invoke('/manual','GET')).state_token,request={version:1,state_token:token,action:'accept'},receipt=await f.invoke('/manual','POST',request),count=f.moves.length;
   assert.deepEqual(await f.invoke('/manual','POST',request),receipt);assert.equal(f.moves.length,count);assert.equal(f.applied,i===6?1:0);
  }
  assert.equal((await f.invoke('/manual','GET')).state,'completed');assert.equal(f.gate.status.maintenance,false);assert(f.moves.every(p=>p[3]===.5));assert.equal(f.stops,0);
  const candidate=await f.invoke('','GET');assert.equal(candidate.state,'candidate');assert(candidate.candidate.final_error<1e-18);
  await f.invoke('','POST',{version:1,state_token:candidate.state_token,action:'save'});assert(f.gate.status.closed);
  const loaded=await KlipperSaveSession.load(f.path);assert.equal(Object.keys(loaded.source.original.delta_calibrate).filter(k=>/^height[0-9]+$/.test(k)).length,7);
 }finally{await f.close();}
});
test('manual Delta cancel invalidates the generation without publishing observations',async()=>{
 const f=await fixture();try{await f.action('start');await f.action('adjust',{delta:-.1});await f.action('cancel');assert.equal(f.stops,1);assert.equal(f.applied,0);assert(f.gate.status.closed);assert.equal((await f.invoke('','GET')).candidate,null);}finally{await f.close();}
});
