import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
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
const removalTimes:number[]=[],times:number[]=[],cpu:number[]=[],mesh=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:32,y_count:32,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},Array.from({length:32},(_,y)=>Array.from({length:32},(_,x)=>(x-y)/12345)));
for(let run=0;run<14;run++){
 const dir=await mkdtemp(join(tmpdir(),'native-config-bench-')),path=join(dir,'printer.cfg');let close:(()=>Promise<void>)|undefined;
 try{await writeFile(path,'[bed_mesh]\n');const loaded=await KlipperSaveSession.load(path),registry=new EndpointRegistry(new JsonRpcDispatcher()),gate=new MaintenanceGate();close=registerNativeConfiguration(registry,loaded.session,gate,new BedMeshProfiles(new ConfigurationReader(loaded.source,null)),{current:()=>mesh,idle:()=>true});const context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}},status=await registry.invoke('/printer/configuration','GET',{},context) as {state_token:string};const start=performance.now(),used=process.cpuUsage();await registry.invoke('/printer/configuration/bed_mesh','POST',{version:1,state_token:status.state_token,profile:'exact'},context);const elapsed=performance.now()-start,usage=process.cpuUsage(used);if(run>=3){times.push(elapsed);cpu.push((usage.user+usage.system)/1000);}const restored=await KlipperSaveSession.load(path);assert.deepEqual(new BedMeshProfiles(new ConfigurationReader(restored.source,null)).load('exact').probedValues(),mesh.probedValues());assert(gate.status.closed);
 const removing=new EndpointRegistry(new JsonRpcDispatcher()),removeGate=new MaintenanceGate(),closeRemove=registerNativeConfiguration(removing,restored.session,removeGate,new BedMeshProfiles(new ConfigurationReader(restored.source,null)),{idle:()=>true,current:()=>{throw Error('Remove must not read current mesh');}});
 try{const state=await removing.invoke('/printer/configuration','GET',{},context) as {state_token:string},begin=performance.now();await removing.invoke('/printer/configuration/bed_mesh','POST',{version:1,state_token:state.state_token,profile:'exact',action:'remove'},context);if(run>=3)removalTimes.push(performance.now()-begin);assert(!Object.hasOwn((await KlipperSaveSession.load(path)).source.original,'bed_mesh exact'));}finally{await closeRemove();}

 }finally{await close?.();await rm(dir,{recursive:true,force:true});}
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};const wall=stats(times);console.log(JSON.stringify({node:process.version,cells:1024,warmup:3,samples:11,wall,removal:stats(removalTimes),cpu:stats(cpu),maximumP95Ms:100,scope:'Idle maintenance save with backup, fsync and exact reload check; warm local filesystem. Reload check excluded from timing. Printing is fenced, not concurrent.'}));assert(wall.p95Ms<100);assert(stats(removalTimes).p95Ms<100);
