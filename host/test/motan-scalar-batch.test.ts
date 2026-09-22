import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {managerFixture,managerDatasets} from './helpers/motan-manager-fixture.ts';
test('scalar batches match row sampling across every family and preserve typed values, time snapshots and selected columns',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-scalar-batch-')),prefix=join(dir,'log');
 try{
  await managerFixture(prefix,2,'corexy',{wide:9007199254740993n,text:'雪,\n😀',flag:false,nil:null,object:{value:1}});
  const fields=['wide','text','flag','nil'].map(k=>`status(export_fields.${k})`),names=[...managerDatasets,...fields],all=[...names,'status(export_fields.object)'];
  for(const typed of [false,true]){
   const row=await MotanLogManager.open(prefix,{reader:{preserveNumberTypes:typed}}),batch=await MotanLogManager.open(prefix,{reader:{preserveNumberTypes:typed}});
   try{
    for(const name of all){row.addDataset(name);batch.addDataset(name);}
    const times=[10.75,11.25,12.75,13.25,14,20],expected=[];for(const time of times)expected.push(await row.sample(time));
    const selection=[...names],pending=batch.sampleScalars(times,1024**2,selection);times.fill(-100);selection.fill('missing');const result=await pending;
    assert.deepEqual(Object.keys(result.datasets),names);assert.equal(Object.getPrototypeOf(result.datasets),null);
    for(const name of names)assert.deepEqual(result.datasets[name],expected.map(value=>value[name]));
    assert.equal(result.datasets[fields[0]][0],9007199254740993n);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.datasets));
    await assert.rejects(batch.sample(19),/concurrent/);
   }finally{await row.close();await batch.close();}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('scalar batches enforce timeline and exact UTF-8/BigInt payload budgets before returning any result',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-scalar-budget-')),prefix=join(dir,'log'),names=['wide','text','nil'].map(k=>`status(export_fields.${k})`);
 try{
  await managerFixture(prefix,2,'corexy',{wide:9007199254740993n,text:'😀',nil:null,object:{bad:1}});
  const manager=await MotanLogManager.open(prefix);try{
   for(const name of names)manager.addDataset(name);
   await assert.rejects(manager.sampleScalars([11,10]),/nondecreasing/);await assert.rejects(manager.sampleScalars([11,NaN]),/nondecreasing/);
   await assert.rejects(manager.sampleScalars([11],31),/memory/);await assert.rejects(manager.sampleScalars([11],1024,['missing']),/Unknown/);
   assert.equal(manager.status.started,false);assert.equal((await manager.sampleScalars([])).scalarBytes,0);assert.equal(manager.status.started,false);
   // Wide integer: 8 + 16*2 = 40; emoji: 8 + 2*2 + 4 = 16;
   // null: 8; snapshot timeline: 8. Total admission charge is 72.
   const result=await manager.sampleScalars([11],72);assert.equal(result.scalarBytes,64);assert.deepEqual(Object.values(result.datasets),[[9007199254740993n],['😀'],[null]]);
  }finally{await manager.close();}
  for(const [selected,budget,error] of [[names,71,/memory/],[['status(export_fields.object)'],1024,/finite scalar/]] as const){
   const manager=await MotanLogManager.open(prefix);try{
    for(const name of selected)manager.addDataset(name);await assert.rejects(manager.sampleScalars([11],budget),error);assert.equal(manager.status.failed,true);await assert.rejects(manager.sample(11),error);
   }finally{await manager.close();}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('scalar batches yield to owner close and exclude row, numeric and scalar operations until completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-scalar-close-')),prefix=join(dir,'log');
 try{
  await managerFixture(prefix);const manager=await MotanLogManager.open(prefix);try{
   manager.addDataset('status(heater.temperature)');await manager.sample(10.75);
   const pending=manager.sampleScalars(Array.from({length:1000},(_,i)=>10.8+i*.0001)).catch(error=>error);
   await assert.rejects(manager.sample(10.8),/concurrent/);await assert.rejects(manager.sampleNumeric([10.8]),/concurrent/);await assert.rejects(manager.sampleScalars([10.8]),/concurrent/);
   assert.throws(()=>manager.addDataset('status(toolhead.print_time)'),/before/);
   const closed=new Promise<void>((resolve,reject)=>setImmediate(()=>manager.close().then(resolve,reject)));
   assert.match(String(await pending),/closed/);await closed;
  }finally{await manager.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
