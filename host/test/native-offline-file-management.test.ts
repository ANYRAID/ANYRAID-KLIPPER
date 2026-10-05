import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeProductFileResources} from '../src/runtime/native-product-machine.ts';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
import {ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-offline-')),options={filesRoot:join(root,'files'),metadataRoot:join(root,'metadata')};
 const resources=await NativeProductFileResources.open(options),lease=resources.acquire(options),files=lease.files;
 await writeFile(join(root,'source'),'G1 X1\n');const source=await open(join(root,'source'),'r');
 await files.publish('original','part.gcode',source,context().signal,'part.gcode');await source.close();lease.release();
 const uploads=await resources.processFiles({stagingRoot:root});uploads.bindOfflineReadiness(()=>true);
 return {root,options,resources,files,uploads,async close(){await resources.close();await rm(root,{recursive:true,force:true});}};
}
test('confirmed offline owner manages durable identities and rejects unauthorized or stale requests',async()=>{
 const f=await fixture(),events:any[]=[];const off=f.uploads.observeChanges(e=>events.push(e));
 try{
  assert.equal(f.uploads.canRemove,true);
  const denied={...context(),authorize(_method:string,p:any){if(p.file_id)throw new ApiError(403,'Denied identity');}};
  await assert.rejects(f.uploads.remove({path:'gcodes/part.gcode'},denied),(e:any)=>e.status===403);assert.equal(events.length,0);
  const generation=new AbortController();generation.abort();
  await assert.rejects(f.uploads.remove({path:'gcodes/part.gcode'},{...context(),nativeGenerationSignal:generation.signal,nativeGenerationRetiredAtAdmission:false}),(e:any)=>e.status===503);
  assert.equal((await f.uploads.move({source:'gcodes/part.gcode',dest:'gcodes/organized.gcode'},context()) as any).action,'move_file');
  assert.equal(await f.files.resolvePath('organized.gcode',context().signal),'original');
  await f.uploads.copy({source:'gcodes/organized.gcode',dest:'gcodes/copied.gcode'},context());const copy=await f.files.resolvePath('copied.gcode',context().signal);assert.notEqual(copy,'original');
  await f.uploads.remove({path:'gcodes/organized.gcode'},{...context(),nativeGenerationSignal:generation.signal,nativeGenerationRetiredAtAdmission:true});
  assert.equal(await f.files.resolvePath('copied.gcode',context().signal),copy);assert.deepEqual(events.map(e=>e.action),['move_file','create_file','delete_file']);
  await f.resources.close();const reopened=await PublishedPrintFiles.open(f.options.filesRoot);try{assert.equal(await reopened.resolvePath('copied.gcode',context().signal),copy);await assert.rejects(reopened.inspect('original'),{code:'ENOENT'});}finally{await reopened.close();}
 }finally{off();await f.close();}
});
test('offline deletion fences new device acquisition and competing mutations until durable commit settles',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const remove=f.files.remove.bind(f.files);let deletion:Promise<unknown>|undefined;
 f.files.remove=async(...args)=>{entered.resolve();await release.promise;return remove(...args);};
 try{
  deletion=f.uploads.remove({path:'gcodes/part.gcode'},context());await entered.promise;
  assert.equal(f.resources.status.offlineMutations,1);assert.throws(()=>f.resources.acquire(f.options),/device attachment/);
  await assert.rejects(f.uploads.move({source:'gcodes/part.gcode',dest:'gcodes/race.gcode'},context()),(e:any)=>e.status===403);
  assert.equal(await f.files.resolvePath('part.gcode',context().signal),'original');release.resolve();await deletion;
  assert.equal(f.resources.status.offlineMutations,0);const lease=f.resources.acquire(f.options);assert.equal(f.uploads.canRemove,false);lease.release();assert.equal(f.uploads.canRemove,true);
 }finally{release.resolve();await deletion?.catch(()=>{});await f.close();}
});
test('device lease and unconfirmed cleanup deny offline mutation while reads remain available',async()=>{
 const f=await fixture();
 try{
  const lease=f.resources.acquire(f.options);assert.equal(f.uploads.canRemove,false);
  await assert.rejects(f.uploads.remove({path:'gcodes/part.gcode'},context()),(e:any)=>e.status===503);
  lease.release(false);assert.equal(f.resources.status.retirementFailed,true);assert.equal(f.uploads.canRemove,false);
  await assert.rejects(f.uploads.copy({source:'gcodes/part.gcode',dest:'gcodes/new.gcode'},context()),(e:any)=>e.status===503);
  assert.throws(()=>f.resources.acquire(f.options),/device attachment/);
  assert.equal((await f.uploads.list({},context().signal) as any[])[0].permissions,'r');assert.equal(await f.files.resolvePath('part.gcode',context().signal),'original');
 }finally{await f.close();}
});
test('device acquired during identity authorization rejects the offline commit with zero effects',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),allowed=Promise.withResolvers<void>();let lease:ReturnType<NativeProductFileResources['acquire']>|undefined,move:Promise<unknown>|undefined;
 const events:any[]=[],off=f.uploads.observeChanges(e=>events.push(e));
 try{
  move=f.uploads.move({source:'gcodes/part.gcode',dest:'gcodes/new.gcode'},{...context(),authorize(_m,p){if(p.file_id){entered.resolve();return allowed.promise;}}});
  const rejected=assert.rejects(move,(e:any)=>e.status===403);await entered.promise;lease=f.resources.acquire(f.options);allowed.resolve();await rejected;
  assert.equal(await f.files.resolvePath('part.gcode',context().signal),'original');assert.equal(events.length,0);assert.equal(f.resources.status.offlineMutations,0);lease.release();lease=undefined;
 }finally{allowed.resolve();await move?.catch(()=>{});lease?.release();off();await f.close();}
});
