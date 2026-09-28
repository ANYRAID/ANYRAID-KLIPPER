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
 let measurements=0,idle=true;const motion={restored:()=>({...asymmetricDeltaCalibration()[0],...(!restored?{probes:[]}:{} )}),idle:()=>idle,measure:async(_s:AbortSignal)=>{measurements++;assert(gate.status.maintenance);return asymmetricDeltaCalibration()[1];},synchronize(){}};
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
 const f=await fixture();try{const c=await f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'});await writeFile(f.path,f.original+'# external\n');await assert.rejects(f.invoke('POST',{version:1,state_token:c.state_token,action:'save'}),/failed/);assert.equal(await readFile(f.path,'utf8'),f.original+'# external\n');assert(f.gate.status.closed);}finally{await f.dispose();}
});
test('closing Delta owner cancels measurement and joins cleanup',async()=>{
 const f=await fixture();try{
  f.motion.measure=s=>new Promise((_,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});});
  const pending=f.invoke('POST',{version:1,state_token:(await f.invoke('GET')).state_token,action:'calibrate'}),rejected=assert.rejects(pending,/failed/);
  await new Promise(resolve=>setImmediate(resolve));await f.close();await rejected;assert(f.gate.status.closed);assert(!f.gate.status.maintenance);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{await f.dispose();}
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
