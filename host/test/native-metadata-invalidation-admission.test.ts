import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {NativePersistentMetadata} from '../src/moonraker/native-persistent-metadata.ts';
import {MetadataVersions} from '../src/moonraker/metadata-versions.ts';
import {NativePrintUploads,registerNativeFileInfo} from '../src/moonraker/native-print-uploads.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {PrintController} from '../src/operations/print.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
const signal=new AbortController().signal;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'metadata-admission-')),files=await PublishedPrintFiles.open(join(dir,'files'));let owner:NativePersistentMetadata|undefined;
 try{await writeFile(join(dir,'source'),'G1 X1\n');const source=await open(join(dir,'source'),'r');try{for(const id of ['active','q1','q2','q3','victim','v2','v3','v4'])await files.publish(id,id+'.gcode',source,signal);}finally{await source.close();}owner=await NativePersistentMetadata.open(join(dir,'metadata'),files);await owner.metadata('victim.gcode',signal);const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),order:string[]=[],acquire=files.acquireBinary.bind(files);let held=true;
  files.acquireBinary=async(...args)=>{order.push(args[0]);if(args[0]==='active'&&held){held=false;entered.resolve();await release.promise;}return acquire(...args);};
  return {dir,files,owner,entered,release,order,async close(){release.resolve();await owner!.close();await files.close();await rm(dir,{recursive:true,force:true});}};
 }catch(error){await owner?.close();await files.close();await rm(dir,{recursive:true,force:true});throw error;}
}
test('durable deletion invalidation is admitted when four read requests are occupied and runs before queued reads',async()=>{
 const f=await fixture(),original=MetadataVersions.prototype.invalidate;const tasks:Promise<unknown>[]=[];
 MetadataVersions.prototype.invalidate=function(...args){if(args[0]==='victim.gcode')f.order.push('invalidate-victim');return Reflect.apply(original,this,args);};
 try{tasks.push(f.owner.metadata('active.gcode',signal));await f.entered.promise;for(const id of ['q1','q2','q3'])tasks.push(f.owner.metadata(id+'.gcode',signal));assert.equal(f.owner.status.pendingRequests,4);await assert.rejects(f.owner.metadata('v2.gcode',signal),/queue full/);
  await f.files.remove('victim',signal);const invalidated=f.owner.invalidate('victim.gcode');tasks.push(invalidated);assert.equal(f.owner.status.pending,5);assert.equal(f.owner.status.pendingInvalidations,1);assert.equal(f.owner.status.faulted,false);f.release.resolve();await Promise.all(tasks);assert.deepEqual(f.order,['active','invalidate-victim','q1','q2','q3']);assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.pendingRequests,0);assert.equal(f.owner.status.pendingInvalidations,0);assert.equal(f.owner.status.faulted,false);
  await f.owner.close();const versions=await MetadataVersions.open(join(f.dir,'metadata','versions'));try{assert.equal(versions.current('victim.gcode')?.state,'invalidated');}finally{await versions.close();}await assert.rejects(f.files.resolvePath('victim.gcode',signal),{code:'ENOENT'});
 }finally{f.release.resolve();await Promise.allSettled(tasks);MetadataVersions.prototype.invalidate=original;await f.close();}
});
test('four reserved invalidations retain FIFO and deduplicate filenames without consuming read capacity',async()=>{
 const f=await fixture(),tasks:Promise<unknown>[]=[];
 try{tasks.push(f.owner.metadata('active.gcode',signal));await f.entered.promise;for(const id of ['q1','q2','q3'])tasks.push(f.owner.metadata(id+'.gcode',signal));const invalidations=['victim','v2','v3','v4'].map(id=>f.owner.invalidate(id+'.gcode'));tasks.push(...invalidations);assert.strictEqual(f.owner.invalidate('victim.gcode'),invalidations[0]);assert.equal(f.owner.status.pending,8);assert.equal(f.owner.status.pendingInvalidations,4);assert.equal(f.owner.status.pendingRequests,4);assert.equal(f.owner.status.faulted,false);const order:string[]=[];invalidations.forEach((task,index)=>void task.then(()=>order.push('v'+index)));f.release.resolve();await Promise.all(tasks);assert.deepEqual(order,['v0','v1','v2','v3']);assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.pendingInvalidations,0);assert.equal(f.owner.status.pendingRequests,0);
 }finally{f.release.resolve();await Promise.allSettled(tasks);await f.close();}
});
test('close drains accepted invalidations while active and queued reads cancel without leaking admission',async()=>{
 const f=await fixture(),tasks:Promise<unknown>[]=[];
 try{tasks.push(f.owner.metadata('active.gcode',signal));await f.entered.promise;tasks.push(f.owner.metadata('q1.gcode',signal));const invalidation=f.owner.invalidate('victim.gcode');tasks.push(invalidation);const close=f.owner.close();await assert.rejects(f.owner.metadata('q2.gcode',signal),/requires recovery/);f.release.resolve();const outcomes=await Promise.allSettled(tasks);assert.deepEqual(outcomes.map(value=>value.status),['rejected','rejected','fulfilled']);await close;assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.pendingRequests,0);assert.equal(f.owner.status.pendingInvalidations,0);assert.equal(f.owner.status.closed,true);
  const versions=await MetadataVersions.open(join(f.dir,'metadata','versions'));try{assert.equal(versions.current('victim.gcode')?.state,'invalidated');}finally{await versions.close();}
 }finally{f.release.resolve();await Promise.allSettled(tasks);await f.close();}
});
test('a replenished invalidation lane yields to a queued read after four turns',async()=>{
 const f=await fixture(),tasks:Promise<unknown>[]=[];
 try{tasks.push(f.owner.metadata('active.gcode',signal));await f.entered.promise;tasks.push(f.owner.metadata('q1.gcode',signal));const invalidations=['victim','v2','v3','v4'].map(id=>f.owner.invalidate(id+'.gcode'));tasks.push(...invalidations);const replenished=invalidations[0].then(()=>f.owner.invalidate('victim.gcode')).then(()=>f.order.push('replenished'));tasks.push(replenished);f.release.resolve();await Promise.all(tasks);assert(f.order.indexOf('q1')<f.order.indexOf('replenished'),'Queued read must start before the replenished fifth invalidation finishes');assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.pendingRequests,0);assert.equal(f.owner.status.pendingInvalidations,0);
 }finally{f.release.resolve();await Promise.allSettled(tasks);await f.close();}
});
test('a fifth distinct invalidation is bounded and retains the existing recovery fault while accepted work drains',async()=>{
 const f=await fixture(),tasks:Promise<unknown>[]=[];
 try{tasks.push(f.owner.metadata('active.gcode',signal));await f.entered.promise;for(const id of ['victim','v2','v3','v4'])tasks.push(f.owner.invalidate(id+'.gcode'));await assert.rejects(f.owner.invalidate('q1.gcode'),/queue full/);assert.equal(f.owner.status.pending,5);assert.equal(f.owner.status.pendingInvalidations,4);assert.equal(f.owner.status.faulted,true);await assert.rejects(f.owner.metadata('q2.gcode',signal),/requires recovery/);f.release.resolve();await Promise.all(tasks);assert.equal(f.owner.status.pending,0);assert.equal(f.owner.status.pendingInvalidations,0);assert.equal(f.owner.status.pendingRequests,0);
 }finally{f.release.resolve();await Promise.allSettled(tasks);await f.close();}
});
test('HTTP deletion at read saturation commits metadata before its file notification and remains usable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'metadata-http-admission-')),files=await PublishedPrintFiles.open(join(dir,'files')),gate=new MaintenanceGate(),release=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),tasks:Promise<unknown>[]=[];let uploads:NativePrintUploads|undefined,controller:PrintController|undefined,network:MoonrakerNetwork|undefined,unobserve:(()=>void)|undefined;
 try{
  await writeFile(join(dir,'source'),'G1 X1\n');const source=await open(join(dir,'source'),'r');try{for(const id of ['active','q1','q2','q3','victim'])await files.publish(id,id+'.gcode',source,signal);}finally{await source.close();}
  uploads=await NativePrintUploads.open(files,gate,{metadataRoot:join(dir,'metadata'),stagingRoot:dir});await uploads.metadata({filename:'victim.gcode'},signal);controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{maintenanceGate:gate});uploads.bindPrintController(controller);
  const acquire=files.acquireBinary.bind(files);let held=true;files.acquireBinary=async(...args)=>{if(args[0]==='active'&&held){held=false;entered.resolve();await release.promise;}return acquire(...args);};
  const events:unknown[]=[],policies:string[]=[],owner=uploads,metadataStatus=()=>{const status=owner.status.metadata;assert('persistent' in status);return status;};unobserve=uploads.observeChanges(event=>{if((event as {action?:string}).action==='delete_file')events.push({event,pendingInvalidations:metadataStatus().pendingInvalidations,faulted:metadataStatus().faulted});});
  const rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);registerNativeFileInfo(endpoints,uploads);network=new MoonrakerNetwork(rpc,{endpoints,nativeUploads:uploads,authorize(method){policies.push(method);}});const address=await network.listen(),base=`http://127.0.0.1:${address.port}`;
  tasks.push(uploads.metadata({filename:'active.gcode'},signal));await entered.promise;for(const id of ['q1','q2','q3'])tasks.push(uploads.metadata({filename:id+'.gcode'},signal));assert.equal(metadataStatus().pendingRequests,4);
  const deletion=fetch(base+'/server/files/gcodes/victim.gcode',{method:'DELETE',signal:AbortSignal.timeout(5000)});tasks.push(deletion);const deadline=Date.now()+3000;while(metadataStatus().pendingInvalidations!==1){assert(Date.now()<deadline,'Deletion did not enter its reserved invalidation slot');await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(uploads.status.metadata.pending,5);assert.equal(events.length,0);release.resolve();const response=await deletion;assert.equal(response.status,200);assert.equal((await response.json()).result.action,'delete_file');await Promise.all(tasks);assert.equal(events.length,1);assert.equal((events[0] as {pendingInvalidations:number}).pendingInvalidations,0);assert.equal((events[0] as {faulted:boolean}).faulted,false);assert(policies.includes('server.files.delete_file'));assert.equal(uploads.status.metadata.pending,0);assert.equal(metadataStatus().faulted,false);assert.equal(uploads.status.mutations,0);await assert.rejects(files.resolvePath('victim.gcode',signal),{code:'ENOENT'});await uploads.metadata({filename:'q1.gcode'},signal);
  await uploads.close();const versions=await MetadataVersions.open(join(dir,'metadata','versions'));try{assert.equal(versions.current('victim.gcode')?.state,'invalidated');}finally{await versions.close();}
 }finally{release.resolve();await Promise.allSettled(tasks);unobserve?.();await network?.close();await controller?.retire();await uploads?.close();await files.close();await rm(dir,{recursive:true,force:true});}
});
