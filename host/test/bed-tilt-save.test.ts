import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerNativeBedTiltSave} from '../src/moonraker/native-bed-tilt.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const endpoint='/printer/configuration/bed_tilt';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'tilt-save-')),path=join(dir,'printer.cfg'),original='[bed_tilt]\nx_adjust: 0\npoints: 0,0\n  10,0\n  0,10\n';await writeFile(path,original);
 const loaded=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher()),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 const tilt={x:.0123456789012345,y:-.0012345678901234,z:.1234567890123456,revision:'1',calibrated:true};let idle=true;
 const close=registerNativeBedTiltSave(registry,gate,{idle:()=>idle,snapshot:()=>({...tilt})},loaded.session);
 const invoke=(verb:string,body:any={})=>registry.invoke(endpoint,verb,body,context) as Promise<any>;
 return {path,original,loaded,gate,registry,context,close,invoke,tilt,idle(v:boolean){idle=v;},async dispose(){await close();await rm(dir,{recursive:true,force:true});}};
}
test('tilt persistence uses measured revision, preserves precision and requires reinitialization',async()=>{
 const f=await fixture();try{
  const stale={version:1,state_token:(await f.invoke('GET')).state_token};f.tilt.revision='2';await assert.rejects(f.invoke('POST',stale),/Stale/);
  const request={version:1,state_token:(await f.invoke('GET')).state_token};await assert.rejects(f.registry.invoke(endpoint,'POST',request,{...f.context,authorize(){throw Error('denied');}}),/denied/);
  await assert.rejects(f.invoke('POST',{...request,x:2}),/Expected/);f.idle(false);await assert.rejects(f.invoke('POST',request),/idle/);f.idle(true);
  f.tilt.calibrated=false;await assert.rejects(f.invoke('POST',request),/calibrated/);f.tilt.calibrated=true;
  const release=f.gate.activity();await assert.rejects(f.invoke('POST',request),/idle/);release();
  const receipt=await f.invoke('POST',request);assert.equal(receipt.state,'saved');assert.equal(receipt.restart_required,true);assert.equal(receipt.available,false);assert.deepEqual(await f.invoke('POST',request),receipt);assert(f.gate.status.closed);assert(f.loaded.session.status.sealedForRestart);
  const restored=await KlipperSaveSession.load(f.path);for(const axis of ['x','y','z'] as const)assert.equal(Number(restored.source.original.bed_tilt[axis+'_adjust']),f.tilt[axis]);assert.equal(restored.source.original.bed_tilt.points,'0,0\n10,0\n0,10');
 }finally{await f.dispose();}
});
test('tilt persistence preserves external edits and blocks further motion after failure',async()=>{
 const f=await fixture();try{const request={version:1,state_token:(await f.invoke('GET')).state_token};await writeFile(f.path,f.original+'# external\n');await assert.rejects(f.invoke('POST',request),/failed/);assert.equal(await readFile(f.path,'utf8'),f.original+'# external\n');assert(f.gate.status.closed);}finally{await f.dispose();}
});
test('closing tilt persistence joins cancellation of an in-flight write',async()=>{
 const f=await fixture();try{
  f.loaded.session.save=async signal=>new Promise((_,reject)=>{signal!.throwIfAborted();signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
  const request={version:1,state_token:(await f.invoke('GET')).state_token},pending=f.invoke('POST',request),rejected=assert.rejects(pending,/failed/);await new Promise(resolve=>setImmediate(resolve));await f.close();await rejected;assert(f.gate.status.closed);assert.equal(f.gate.status.maintenance,false);assert.equal(await readFile(f.path,'utf8'),f.original);
 }finally{await f.dispose();}
});
