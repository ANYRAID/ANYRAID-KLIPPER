import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runProductHost} from '../src/runtime/product-host.ts';
import {ProductHostControl} from '../src/runtime/product-host-control.ts';
import {productHostFixture} from './helpers/product-host-profile.ts';
for(const cancel of [false,true])test(`reinitialization waits for old dependency release and respects shutdown (cancel=${cancel})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-reinitialize-')),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const generations:Awaited<ReturnType<typeof productHostFixture>>[]=[];let completed=false;
 const running=runProductHost(async()=>{
  assert(generations.every(g=>g.released));const f=await productHostFixture(dir);generations.push(f);
  if(generations.length===1){const original=f.profile.release;f.profile.release=async()=>{entered.resolve();await release.promise;await original();};}
  return f.profile;
 },abort.signal,()=>ready.resolve(),control);void running.catch(error=>ready.reject(error));
 try{
  await ready.promise;const request=control.reinitialize();assert.equal(control.reinitialize(),request);const observed=request.then(()=>{completed=true;},error=>{if(!cancel)throw error;return error;});
  await entered.promise;assert.equal(generations.length,1);assert.equal(completed,false);assert.equal(generations[0].released,false);
  if(cancel)abort.abort(new Error('cancel restart'));release.resolve();await observed;
  assert.equal(generations.length,cancel?1:2);assert.equal(completed,!cancel);assert(generations[0].released);abort.abort();await running;
  assert(generations.every(g=>g.released));await assert.rejects(control.reinitialize(),/not ready/);
 }finally{release.resolve();abort.abort();await running.catch(()=>{});for(const g of generations)await g.profile.release();await rm(dir,{recursive:true,force:true});}
});
test('dependency release failure rejects recovery without opening a replacement generation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-reinit-error-')),f=await productHostFixture(dir),control=new ProductHostControl(),abort=new AbortController(),ready=Promise.withResolvers<void>();let calls=0;
 const original=f.profile.release;f.profile.release=async()=>{await original();throw new Error('dependency retirement failed');};
 const running=runProductHost(async()=>{calls++;return f.profile;},abort.signal,()=>ready.resolve(),control);void running.catch(error=>ready.reject(error));
 try{await ready.promise;const result=assert.rejects(running,/retirement failed/);await assert.rejects(control.reinitialize(),/reinitialization failed/);await result;assert.equal(calls,1);assert(f.released);}finally{abort.abort();await running.catch(()=>{});await original();await rm(dir,{recursive:true,force:true});}
});
