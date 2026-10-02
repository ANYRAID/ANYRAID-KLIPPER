import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerNativeConfiguration} from '../src/moonraker/native-configuration.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
for(const conflict of [false,true])test(`native configuration save is gated, exact, fenced and detects external edits (${conflict})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-config-')),path=join(dir,'printer.cfg'),original='[printer]\nkinematics: cartesian\n[bed_mesh]\n';await writeFile(path,original);
 const loaded=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());let idle=false,copies=0;
 const mesh=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.123456789012345,.2],[.3,.4]]);mesh.setOffsets(12,13);
 const close=registerNativeConfiguration(registry,loaded.session,gate,new BedMeshProfiles(new ConfigurationReader(loaded.source,null)),{current:()=>{copies++;return mesh;},idle:()=>idle});
 const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};
 const invoke=(p:string,verb:string,params:any={})=>registry.invoke(p,verb,params,context) as Promise<any>;
 try{
  const status=await invoke('/printer/configuration','GET'),request={version:1,state_token:status.state_token,profile:'precise'};
  await assert.rejects(invoke('/printer/configuration/bed_mesh','POST',request),/idle/);assert.equal(copies,0);assert.equal(await readFile(path,'utf8'),original);idle=true;
  await assert.rejects(registry.invoke('/printer/configuration/bed_mesh','POST',request,{...context,authorize:()=>{throw Error('denied');}}),/denied/);
  const activity=gate.activity();await assert.rejects(invoke('/printer/configuration/bed_mesh','POST',request),/activity/);assert.equal(copies,0);activity();
  await assert.rejects(invoke('/printer/configuration/bed_mesh','POST',{...request,state_token:'stale'}),/Stale/);
  if(conflict){await writeFile(path,original+'# edited\n');await assert.rejects(invoke('/printer/configuration/bed_mesh','POST',request),/failed/);assert.equal(await readFile(path,'utf8'),original+'# edited\n');assert.equal((await invoke('/printer/configuration','GET')).state,'failed');}
  else{
   const result=await invoke('/printer/configuration/bed_mesh','POST',request);assert.equal(result.state,'saved');assert.equal(result.restart_required,true);assert.deepEqual(await invoke('/printer/configuration/bed_mesh','POST',request),result);
   const restored=await KlipperSaveSession.load(path),saved=new BedMeshProfiles(new ConfigurationReader(restored.source,null)).load('precise');assert.deepEqual(saved.probedValues(),mesh.probedValues());assert.equal(saved.calcZ(0,0),.123456789012345);assert((await readdir(dir)).length>=2);assert(loaded.session.status.sealedForRestart);
  }
  assert(gate.status.closed);assert.throws(()=>gate.activity());
 }finally{await close();await rm(dir,{recursive:true,force:true});}
});
