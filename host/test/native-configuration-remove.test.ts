import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerNativeConfiguration} from '../src/moonraker/native-configuration.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {buildKlipperSave} from '../src/config/klipper-save.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
for(const mode of ['last','other-section','include-shadow'] as const)test(`native profile removal persists and rejects inherited definitions: ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-remove-')),path=join(dir,'printer.cfg'),values={version:'1',min_x:'0',max_x:'100',min_y:'0',max_y:'100',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'\n.1,.2\n.3,.4'};
 let close:(()=>Promise<void>)|undefined;
 try{
  const regular='[bed_mesh]\n'+(mode==='include-shadow'?'[include child.cfg]\n':''),saved={'bed_mesh removed':values,...mode==='other-section'?{other:{value:'precise'}}:{}};
  if(mode==='include-shadow')await writeFile(join(dir,'child.cfg'),'[bed_mesh removed]\nversion: 1\n');const text=buildKlipperSave(regular,saved)!.text;await writeFile(path,text);
  const loaded=await KlipperSaveSession.load(path),gate=new MaintenanceGate(),registry=new EndpointRegistry(new JsonRpcDispatcher());close=registerNativeConfiguration(registry,loaded.session,gate,new BedMeshProfiles(new ConfigurationReader(loaded.source,null)),{idle:()=>true,current:()=>{throw Error('Delete must not copy active mesh');}});
  const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}},invoke=(params:any)=>registry.invoke('/printer/configuration/bed_mesh','POST',params,context),status=await registry.invoke('/printer/configuration','GET',{},context) as any;
  await assert.rejects(invoke({version:1,state_token:status.state_token,profile:'missing',action:'remove'}),/not in/);assert(!gate.status.closed);
  const request={version:1,state_token:status.state_token,profile:'removed',action:'remove'};
  if(mode==='include-shadow'){await assert.rejects(invoke(request),/failed/);assert.equal(await readFile(path,'utf8'),text);}
  else{const result=await invoke(request);assert.deepEqual(await invoke(request),result);const restored=await KlipperSaveSession.load(path);assert(!Object.hasOwn(restored.source.original,'bed_mesh removed'));assert(!restored.session.hasSavedSection('bed_mesh removed'));if(mode==='other-section')assert.equal(restored.source.original.other.value,'precise');await assert.rejects(invoke({...request,action:'save'}),/requires/);}
  assert(gate.status.closed);
 }finally{await close?.();await rm(dir,{recursive:true,force:true});}
});
