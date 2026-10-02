import {measuredDeltaObject} from './helpers/delta-object.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {registerNativeDeltaCalibration} from '../src/moonraker/native-delta-calibration.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {asymmetricDeltaCalibration} from './helpers/delta-calibration.ts';
const endpoint='/printer/calibration/delta';
async function fixture(restored=false){
 const dir=await mkdtemp('/tmp/delta-endpoint-'),path=dir+'/printer.cfg',original='[printer]\nkinematics: delta\ndelta_radius: 100\n[delta_calibrate]\nradius: 65\n';await writeFile(path,original);
 const {session}=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 let measurements=0,idle=true;const motion={captureStable:async(_s:AbortSignal)=>asymmetricDeltaCalibration()[0].probes[0].stable,restored:()=>({...asymmetricDeltaCalibration()[0],...(!restored?{probes:[]}:{} )}),idle:()=>idle,measure:async(_s:AbortSignal)=>{measurements++;assert(gate.status.maintenance);return asymmetricDeltaCalibration()[1];},synchronize(){},validateGeometry(_geometry:unknown){}};
 const close=registerNativeDeltaCalibration(registry,gate,motion,session),invoke=(verb:string,body:any={})=>registry.invoke(endpoint,verb,body,context) as Promise<any>;
 return {session,gate,path,original,registry,context,motion,invoke,close,count:()=>measurements,setIdle(v:boolean){idle=v;},async dispose(){await close();await rm(dir,{recursive:true,force:true});}};
}
test('Delta endpoint measures, fits and saves a server candidate with authenticated idempotent actions',async()=>{
 const f=await fixture();try{
  const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'};
  await assert.rejects(f.registry.invoke(endpoint,'POST',request,{...f.context,authorize(){throw Error('denied');}}),/denied/);
  await assert.rejects(f.invoke('POST',{...request,geometry:{}}),/Expected/);f.setIdle(false);await assert.rejects(f.invoke('POST',request),/idle/);f.setIdle(true);
  const release=f.gate.activity();await assert.rejects(f.invoke('POST',request),/blocks/);release();
  const candidate=await f.invoke('POST',request);assert.equal(candidate.state,'candidate');assert(candidate.candidate.final_error<1e-18);assert.equal(candidate.can_save,true);assert.deepEqual(await f.invoke('POST',request),candidate);assert.equal(f.count(),1);
  assert.equal(await readFile(f.path,'utf8'),f.original);
  const save={version:1,state_token:candidate.state_token,action:'save'};const saved=await f.invoke('POST',save);assert.equal(saved.state,'saved');assert(saved.restart_required);assert(!saved.available);assert(f.gate.status.closed);assert(f.session.status.sealedForRestart);assert.deepEqual(await f.invoke('POST',save),saved);
  const restored=await KlipperSaveSession.load(f.path);assert.equal(Number(restored.source.original.printer.delta_radius),candidate.candidate.geometry.radius);
 }finally{await f.dispose();}
});
test('Delta save failure preserves external edits and invalidates the generation',async()=>{
 const f=await fixture();try{const c=await f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'});await writeFile(f.path,f.original+'# external\n');await assert.rejects(f.invoke('POST',{version:1,state_token:c.state_token,action:'save'}),/failed/);assert.equal(await readFile(f.path,'utf8'),f.original+'# external\n');assert(f.gate.status.closed);assert.equal(f.close.diagnostic().failure!.stage,'save');assert(f.close.diagnostic().input);}finally{await f.dispose();}
});

for(const stage of ['measure','synchronize','fit','validate'] as const)test('Delta local diagnostic preserves '+stage+' failure without changing wire errors or admitting retry',async()=>{
 const f=await fixture(),cause=new Error('private '+stage+' failure');
 try{
  if(stage==='measure')f.motion.measure=async()=>{throw cause;};
  if(stage==='synchronize')f.motion.synchronize=()=>{throw cause;};
  if(stage==='fit')f.motion.measure=async()=>{const input=asymmetricDeltaCalibration()[1];return {...input,probes:Array(7).fill(input.probes[0]),distances:[]};};
  if(stage==='validate')f.motion.validateGeometry=()=>{throw cause;};
  const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'};
  await assert.rejects(f.invoke('POST',request),error=>error instanceof Error&&error.message==='Delta calibration failed; reinitialize and inspect configuration'&&!Object.hasOwn(error,'cause'));
  const local=f.close.diagnostic();assert.equal(local.failure!.stage,stage);assert.equal(local.failure!.action,'calibrate');
  if(stage==='fit')assert.match((local.failure!.cause as Error).message,/independent calibration constraints/);else assert.equal(local.failure!.cause,cause);
  if(stage==='measure')assert.equal(local.input,undefined);
  else{assert(local.input);const radius=local.input.geometry.radius;local.input.geometry.radius=-1;assert.equal(f.close.diagnostic().input!.geometry.radius,radius);}
  const wire=await f.invoke('GET');assert.equal(wire.state,'failed');assert.equal(wire.available,false);assert.equal(wire.candidate,null);assert(!('failure' in wire)&&!('input' in wire));
  assert(f.gate.status.closed);assert(!f.gate.status.maintenance);assert.equal(await readFile(f.path,'utf8'),f.original);await assert.rejects(f.invoke('POST',request),/idle homed/);
 }finally{await f.dispose();}
});
test('closing Delta owner cancels measurement and joins cleanup',async()=>{
 const f=await fixture();try{
  f.motion.measure=s=>new Promise((_,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});});
  const pending=f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'}),rejected=assert.rejects(pending,/failed/);
  await new Promise(resolve=>setImmediate(resolve));await f.close();await rejected;assert(f.gate.status.closed);assert(!f.gate.status.maintenance);assert.equal(await readFile(f.path,'utf8'),f.original);assert.equal(f.close.diagnostic().failure!.stage,'measure');assert.match(String(f.close.diagnostic().failure!.cause),/owner closed/);
 }finally{await f.dispose();}
});

test('manual height failure retains the local capture cause without exposing it on the wire',async()=>{
 const f=await fixture(true),cause=new Error('capture unavailable');
 try{
  f.motion.captureStable=async()=>{throw cause;};
  await assert.rejects(f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'height',height:0}),/Delta calibration failed/);
  const diagnostic=f.close.diagnostic();assert.equal(diagnostic.failure!.action,'height');assert.equal(diagnostic.failure!.stage,'capture');assert.equal(diagnostic.failure!.cause,cause);assert.equal(diagnostic.input,undefined);
  assert.equal((await f.invoke('GET')).candidate,null);assert(f.gate.status.closed);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{await f.dispose();}
});

for(const stage of ['fit','validate'] as const)test('manual Delta failure retains '+stage+' input and rejects candidate reuse',async()=>{
 const f=await fixture(),release=f.gate.acquire(),cause=new Error('manual geometry rejected'),input=asymmetricDeltaCalibration()[1];
 try{
  if(stage==='fit'){input.probes=Array(7).fill(input.probes[0]);input.distances=[];}else f.motion.validateGeometry=()=>{throw cause;};
  await assert.rejects(f.close.acceptManual(input,new AbortController().signal),stage==='fit'?/independent calibration constraints/:error=>error===cause);
  const local=f.close.diagnostic();assert.equal(local.failure!.action,'manual');assert.equal(local.failure!.stage,stage);assert.deepEqual(local.input,{...input,manual:input.manual});
  input.geometry.radius=-1;assert.notEqual(f.close.diagnostic().input!.geometry.radius,-1);
  const wire=await f.invoke('GET');assert.equal(wire.state,'failed');assert.equal(wire.candidate,null);assert.equal(wire.available,false);assert(f.gate.status.closed);
  await assert.rejects(f.close.acceptManual(asymmetricDeltaCalibration()[1],new AbortController().signal),/no active maintenance owner/);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{release();await f.dispose();}
});

test('Delta extension fits typed object dimensions without repeated probing',async()=>{
 const f=await fixture();try{
  const initial=await f.invoke('GET');await assert.rejects(f.invoke('POST',{version:1,state_token:initial.state_token,action:'extend',measurements:measuredDeltaObject().measurements}),/basic/);
  const basic=await f.invoke('POST',{version:1,state_token:initial.state_token,action:'calibrate'}),request={version:1,state_token:basic.state_token,action:'extend',measurements:measuredDeltaObject().measurements};
  await assert.rejects(f.invoke('POST',{...request,measurements:{}}),/Invalid/);assert.equal((await f.invoke('GET')).state,'candidate');assert(!f.gate.status.closed);
  const result=await f.invoke('POST',request);assert.equal(result.state,'candidate');assert(result.candidate.distance_residuals.every((v:number)=>Math.abs(v)<1e-7));assert.equal(result.candidate.distance_residuals.length,12);assert.equal(f.count(),1);assert.deepEqual(await f.invoke('POST',request),result);assert.equal(f.count(),1);
  await f.invoke('POST',{version:1,state_token:result.state_token,action:'save'});const saved=await KlipperSaveSession.load(f.path);assert.equal(Object.keys(saved.source.original.delta_calibrate).filter(k=>/^distance[0-9]+$/.test(k)).length,12);
 }finally{await f.dispose();}
});

test('Delta extension reuses restored heights after restart without probe motion',async()=>{
 const f=await fixture(true);try{const state=await f.invoke('GET'),result=await f.invoke('POST',{version:1,state_token:state.state_token,action:'extend',measurements:measuredDeltaObject().measurements});assert.equal(result.state,'candidate');assert.equal(f.count(),0);assert.equal(result.candidate.distance_residuals.length,12);}finally{await f.dispose();}
});

for(const restored of [false,true])test('manual height is captured once and survives subsequent fitting; restored='+restored,async()=>{
 const f=await fixture(restored);try{
  const height=asymmetricDeltaCalibration()[0].probes[0].height,request={version:1,state_token:(await f.invoke('GET')).state_token,action:'height',height};
  await assert.rejects(f.invoke('POST',{...request,stable:[1,2,3]}),/Expected/);await assert.rejects(f.invoke('POST',{...request,height:'0'}),/finite/);
  const recorded=await f.invoke('POST',request);assert.equal(recorded.manual_count,1);assert.equal(recorded.candidate,null);assert.equal(f.count(),0);assert.deepEqual(await f.invoke('POST',request),recorded);await assert.rejects(f.invoke('POST',{...request,height:height+1}),/conflicts/);
  await assert.rejects(f.invoke('POST',{version:1,state_token:recorded.state_token,action:'save'}),/candidate/);
  if(!restored)await f.invoke('POST',{version:1,state_token:recorded.state_token,action:'calibrate'});
  const fitted=await f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'extend',measurements:measuredDeltaObject().measurements});assert.equal(fitted.manual_count,1);assert.equal(fitted.candidate.height_residuals.length,8);
  await f.invoke('POST',{version:1,state_token:fitted.state_token,action:'save'});const loaded=await KlipperSaveSession.load(f.path);assert.equal(Number(loaded.source.original.delta_calibrate.manual_height0),height);assert.equal(loaded.source.original.delta_calibrate.manual_height0_pos,asymmetricDeltaCalibration()[0].probes[0].stable.join(','));
 }finally{await f.dispose();}
});
