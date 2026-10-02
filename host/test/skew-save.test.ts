import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerNativeSkewSave} from '../src/moonraker/native-skew-save.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
const factors={xy:.01234567890123456,xz:-.02345678901234567,yz:.03456789012345678};
async function owner(path:string){const loaded=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let revision='1';
 const close=registerNativeSkewSave(registry,gate,{snapshot:()=>({revision,factors}),idle:()=>true},loaded.session);
 const invoke=(verb:string,params:any={})=>registry.invoke('/printer/configuration/skew',verb,params,{transport:'http',signal:new AbortController().signal,authorize(){}}) as Promise<any>;
 return {loaded,gate,close,invoke,edit(){revision='2';}};
}
test('skew persistence round trips exact coefficients, retries safely and removes autosaved profiles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'skew-save-')),path=join(dir,'printer.cfg');await writeFile(path,'[skew_correction]\n');let f=await owner(path);
 try{
  const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'save',profile:'measured'};
  await assert.rejects(f.invoke('POST',{...request,xy:1}),/Expected/);const receipt=await f.invoke('POST',request);assert(receipt.restart_required);assert(f.gate.status.closed);assert(f.loaded.session.status.sealedForRestart);assert.deepEqual(await f.invoke('POST',request),receipt);await assert.rejects(f.invoke('POST',{...request,profile:'other'}),/conflicts/);
  await f.close();f=await owner(path);for(const axis of ['xy','xz','yz'] as const)assert.equal(Number(f.loaded.source.original['skew_correction measured'][axis+'_skew']),factors[axis]);
  const remove={version:1,state_token:(await f.invoke('GET')).state_token,action:'remove',profile:'measured'};await f.invoke('POST',remove);const restored=await KlipperSaveSession.load(path);assert.equal(restored.source.original['skew_correction measured'],undefined);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('external edits and stale motion revisions cannot be overwritten',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'skew-conflict-')),path=join(dir,'printer.cfg'),initial='[skew_correction]\n';await writeFile(path,initial);const f=await owner(path);
 try{const request={version:1,state_token:(await f.invoke('GET')).state_token,action:'save',profile:'measured'};f.edit();await assert.rejects(f.invoke('POST',request),/Stale/);request.state_token=(await f.invoke('GET')).state_token;await writeFile(path,initial+'# external\n');await assert.rejects(f.invoke('POST',request),/failed/);assert.equal(await readFile(path,'utf8'),initial+'# external\n');assert(f.gate.status.closed);}finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
