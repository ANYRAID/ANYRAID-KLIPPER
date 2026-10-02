import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calibrateZEndstop} from '../src/homing/z-endstop.ts';
import {registerNativeZEndstop} from '../src/moonraker/native-z-endstop.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const measure='/printer/calibration/z_endstop',save='/printer/configuration/z_endstop',context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'z-endstop-')),path=join(dir,'printer.cfg'),original='[stepper_z]\nposition_endstop: 0\nposition_min: -2\nposition_max: 10\n';await writeFile(path,original);
 const {session}=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let position=[2,3,1,0],stops=0;
 const close=registerNativeZEndstop(registry,gate,{idle:()=>true,planned:()=>[...position],measured:()=>[...position],limits:{axisMinimum:[0,0,-2],axisMaximum:[10,10,10]},move:async(p,_v,s)=>{s.throwIfAborted();position=[...p];},synchronize(){},stop:async()=>{stops++;},subscribeStop:()=>()=>{}},0,session);
 const get=(path=measure)=>registry.invoke(path,'GET',{},context) as Promise<any>,post=(path:string,body:any)=>registry.invoke(path,'POST',body,context) as Promise<any>,act=async(action:string,extra={})=>post(measure,{version:1,state_token:(await get()).state_token,action,...extra});
 return {path,original,registry,session,gate,get,post,act,close,get stops(){return stops;},async dispose(){await close();await rm(dir,{recursive:true,force:true});}};
}
test('endstop conversion preserves sub-micron values and rejects invalid ranges',()=>{
 assert.equal(calibrateZEndstop(.25,.125,-1,10),.125);assert.equal(calibrateZEndstop(0,-.125,-1,10),.125);
 assert.equal(calibrateZEndstop(0,.1234567890123456,-1,10),-.1234567890123456);
 for(const args of [[NaN,0,-1,1],[0,Infinity,-1,1],[0,0,1,1],[0,2,-1,1],[1,-1,-1,1]])assert.throws(()=>calibrateZEndstop(...args as [number,number,number,number]));
});
for(const failure of [false,true])test(`endstop measurement saves only accepted contact and reloads exact value (external edit=${failure})`,async()=>{
 const f=await fixture();try{
  const stale={version:1,state_token:(await f.get(save)).state_token};await assert.rejects(f.post(save,stale),/calibrated/);await f.act('start');await f.act('adjust',{delta:-.123456789});const contact=(await f.get()).position[2];const accepted=await f.act('accept');assert.equal(accepted.result.position_endstop,-contact);assert.equal(await readFile(f.path,'utf8'),f.original);
  await assert.rejects(f.post(save,stale),/Stale/);const request={version:1,state_token:(await f.get(save)).state_token};await assert.rejects(f.post(save,{...request,position_endstop:3}),/Expected/);
  await assert.rejects(f.registry.invoke(save,'POST',request,{...context,authorize(){throw Error('denied');}}),/denied/);
  if(failure){await writeFile(f.path,f.original+'# edited\n');await assert.rejects(f.post(save,request),/failed/);assert.equal(await readFile(f.path,'utf8'),f.original+'# edited\n');}
  else{const done=await f.post(save,request);assert.equal(done.state,'saved');assert(done.restart_required);assert.deepEqual(await f.post(save,request),done);assert(f.session.status.sealedForRestart);const loaded=await KlipperSaveSession.load(f.path);assert.equal(Number(loaded.source.original.stepper_z.position_endstop),-contact);assert.equal(loaded.source.original.stepper_z.position_min,'-2');await assert.rejects(f.act('start'),/idle homed/);}
  assert(f.gate.status.closed);assert.equal(f.stops,0);
 }finally{await f.dispose();}
});
test('endstop save close cancels and joins in-flight persistence',async()=>{
 const f=await fixture();try{
  await f.act('start');await f.act('adjust',{delta:-.1});await f.act('accept');f.session.save=async signal=>new Promise((_,reject)=>{signal!.throwIfAborted();signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
  const p=f.post(save,{version:1,state_token:(await f.get(save)).state_token}),failed=assert.rejects(p,/failed/);await new Promise(resolve=>setImmediate(resolve));await f.close();await failed;assert(f.gate.status.closed);assert(!f.gate.status.maintenance);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{await f.dispose();}
});
