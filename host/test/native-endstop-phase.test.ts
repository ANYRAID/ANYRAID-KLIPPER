import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerNativeEndstopPhase} from '../src/moonraker/native-endstop-phase.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const endpoint='/printer/calibration/endstop_phase';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'phase-save-')),path=join(dir,'printer.cfg'),original='[printer]\nkinematics: cartesian\n[endstop_phase stepper_x]\nendstop_accuracy: 0.04\nendstop_align_zero: true\n';await writeFile(path,original);
 const loaded=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 let revision=0,idle=true,samples=true;
 const close=registerNativeEndstopPhase(registry,gate,{idle:()=>idle,snapshot:()=>({revision:String(revision),steppers:[{name:'stepper_x',primary:true,correction_enabled:true,last_phase:3,last_mcu_position:'1267650600228229401496703205377',samples:samples?'12':'0',calibration:samples?{phase:3,phases:64,low:2,high:4,cost:'5'}:null}]})},loaded.session);
 const invoke=(verb:string,body:any={})=>registry.invoke(endpoint,verb,body,context) as Promise<any>;
 return {path,original,loaded,gate,registry,context,close,invoke,change(){revision++;},idle(v:boolean){idle=v;},samples(v:boolean){samples=v;},async dispose(){await close();await rm(dir,{recursive:true,force:true});}};
}
const body=(state:any)=>({version:1,state_token:state.state_token,stepper:'stepper_x',action:'save'});
test('phase preview save validates authorization, observation revisions and idle ownership',async()=>{
 const f=await fixture();try{
  let request=body(await f.invoke('GET'));await assert.rejects(f.registry.invoke(endpoint,'POST',request,{...f.context,authorize(){throw Error('denied');}}),/denied/);
  for(const extra of [{phase:7},{stepper:'unknown'},{version:2},{action:'activate'}])await assert.rejects(f.invoke('POST',{...request,...extra}));
  f.change();await assert.rejects(f.invoke('POST',request),/Stale/);request=body(await f.invoke('GET'));
  f.samples(false);await assert.rejects(f.invoke('POST',request),/Home/);f.samples(true);f.idle(false);await assert.rejects(f.invoke('POST',request),/idle/);f.idle(true);
  const release=f.gate.activity();await assert.rejects(f.invoke('POST',request),/idle/);release();assert.equal(await readFile(f.path,'utf8'),f.original);
  const receipt=await f.invoke('POST',request);assert.equal(receipt.saved_phase,'3/64');assert.equal(receipt.restart_required,true);assert.equal(receipt.persisted,true);assert.equal(receipt.available,false);
  assert.deepEqual(await f.invoke('POST',request),receipt);await assert.rejects(f.invoke('POST',{...request,stepper:'stepper_y'}),/conflicts/);
  const restored=await KlipperSaveSession.load(f.path);assert.equal(restored.source.original['endstop_phase stepper_x'].trigger_phase,'3/64');assert.equal(restored.source.original['endstop_phase stepper_x'].endstop_accuracy,'0.04');assert.equal(restored.source.original['endstop_phase stepper_x'].endstop_align_zero,'true');assert(f.loaded.session.status.sealedForRestart);assert(f.gate.status.closed);
 }finally{await f.dispose();}
});
test('external configuration changes fail closed without overwriting user edits',async()=>{
 const f=await fixture();try{const request=body(await f.invoke('GET'));await writeFile(f.path,f.original+'# external\n');await assert.rejects(f.invoke('POST',request),/failed/);assert.equal(await readFile(f.path,'utf8'),f.original+'# external\n');assert(f.gate.status.closed);assert.equal((await f.invoke('GET')).state,'failed');}finally{await f.dispose();}
});
test('authorization resolving after close cannot save retired phase observations',async()=>{
 const f=await fixture(),authorized=Promise.withResolvers<void>();try{const request=body(await f.invoke('GET')),pending=f.registry.invoke(endpoint,'POST',request,{...f.context,authorize:()=>authorized.promise});await f.close();authorized.resolve();await assert.rejects(pending,/closed/);assert.equal(await readFile(f.path,'utf8'),f.original);}finally{authorized.resolve();await f.dispose();}
});
test('closing joins an in-flight phase save and fences further print admission',async()=>{
 const f=await fixture();try{
  f.loaded.session.save=async signal=>new Promise((_,reject)=>{signal!.throwIfAborted();signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
  const request=body(await f.invoke('GET')),pending=f.invoke('POST',request),rejected=assert.rejects(pending,/failed/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.gate.status.maintenance,true);await f.close();await rejected;assert(f.gate.status.closed);assert.equal(f.gate.status.maintenance,false);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{await f.dispose();}
});
