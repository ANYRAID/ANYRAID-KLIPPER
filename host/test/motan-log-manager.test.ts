import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {MotanLogManager,splitMotanName,splitMotanParameters} from '../src/motan/log-manager.ts';
import {managerFixture,managerDatasets} from './helpers/motan-manager-fixture.ts';
import {managerOracle} from './helpers/motan-manager-oracle.ts';
test('Motan numeric batches preserve time-major sampling and snapshot times without exporting unselected datasets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-batch-')),prefix=join(dir,'capture');
 try{await managerFixture(prefix);const row=await MotanLogManager.open(prefix),batch=await MotanLogManager.open(prefix);
  try{for(const name of managerDatasets){row.addDataset(name);batch.addDataset(name);}
   const names=managerDatasets.filter(name=>!name.startsWith('stallguard('));
   const times=[10.75,11.25,12.75,13.25,14],expected=[];
   for(const time of times)expected.push(await row.sample(time));
   const pending=batch.sampleNumeric(times,1024**2,names);times.fill(-100);
   const result=await pending;assert.deepEqual(Object.keys(result),names);
   for(const name of names)assert.deepEqual(Array.from(result[name]),expected.map(values=>values[name]));
   assert.ok(Object.isFrozen(result));await assert.rejects(batch.sample(13),/concurrent/);
  }finally{await row.close();await batch.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan numeric batches validate budgets and all times before consuming records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-batch-limits-')),prefix=join(dir,'capture');
 try{await managerFixture(prefix);const manager=await MotanLogManager.open(prefix);
  try{manager.addDataset('accelerometer(a,x)');
   await assert.rejects(manager.sampleNumeric([11,10]),/nondecreasing/);
   await assert.rejects(manager.sampleNumeric([11,NaN]),/nondecreasing/);
   await assert.rejects(manager.sampleNumeric([11],15),/memory/);
   await assert.rejects(manager.sampleNumeric([11],1024,['missing']),/Unknown/);
   assert.equal(manager.status.started,false);
   assert.equal((await manager.sampleNumeric([]))['accelerometer(a,x)'].length,0);
   assert.equal(manager.status.started,false);
   assert.equal((await manager.sampleNumeric([11,11]))['accelerometer(a,x)'].length,2);
  }finally{await manager.close();}
  const failing=await MotanLogManager.open(prefix);try{
   failing.addDataset('stallguard(stepper_x,sg_result)');
   await assert.rejects(failing.sampleNumeric([20]),/cannot represent/);
   await assert.rejects(failing.sample(20),/cannot represent/);
  }finally{await failing.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan numeric batch yields to owner close and excludes concurrent operations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-batch-close-')),prefix=join(dir,'capture');
 try{await managerFixture(prefix);const manager=await MotanLogManager.open(prefix);
  try{manager.addDataset('accelerometer(a,x)');await manager.sample(10.75);
   const pending=manager.sampleNumeric(Array.from({length:1000},(_,i)=>10.8+i*.0001)).catch(error=>error);
   await assert.rejects(manager.sample(10.8),/concurrent/);
   await assert.rejects(manager.sampleNumeric([10.8]),/concurrent/);
   assert.throws(()=>manager.addDataset('accelerometer(a,y)'),/before/);
   let yielded=false;const closed=new Promise<void>((resolve,reject)=>setImmediate(()=>{
    yielded=true;manager.close().then(resolve,reject);
   }));
   assert.match(String(await pending),/closed/);await closed;assert.equal(yielded,true);
  }finally{await manager.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan manager resolves every dataset family and labels against original Python on actual gzip/index files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-manager-')),prefix=join(dir,'capture');try{await managerFixture(prefix);for(const [start,times] of [[0,[10.75,11.25,12.75,13.25,14]],[4,[14,14.5]]] as [number,number[]][]){const expected=managerOracle(prefix,start,managerDatasets,times),manager=await MotanLogManager.open(prefix,{start});try{assert.equal(manager.startTime,expected.start);assert.equal(manager.initialStartTime,10);assert.equal((manager.initialStatus.toolhead as {estimated_print_time:number}).estimated_print_time,10);for(const name of managerDatasets){const info=manager.addDataset(name);assert.deepEqual({label:info.label,units:info.units},expected.labels[name]);assert.equal(manager.addDataset(name),info);}const values=[];for(const time of times)values.push({...await manager.sample(time)});assert.deepEqual(values,expected.values);assert.throws(()=>manager.addDataset('status(new)'),/before/);}finally{await manager.close();}}}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan index pre-roll uses max estimated/print time and immutable start snapshots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-index-')),prefix=join(dir,'capture');try{const fixture=await managerFixture(prefix);let manager=await MotanLogManager.open(prefix,{start:4});assert.equal(manager.filePosition,fixture.positions[0]);assert.equal((manager.startStatus.heater as {temperature:number}).temperature,25);assert.equal((manager.initialStatus.heater as {temperature:number}).temperature,20);assert.throws(()=>((manager.initialStatus.heater as {temperature:number}).temperature=99),TypeError);await manager.close();const index=[{status:fixture.initial,subscriptions:{},file_position:0},{status:{toolhead:{estimated_print_time:12,print_time:20}},file_position:fixture.positions[0]}];await writeFile(prefix+'.index.gz',gzipSync(index.map(v=>JSON.stringify(v)+'\x03').join('')));manager=await MotanLogManager.open(prefix,{start:4});assert.equal(manager.filePosition,0);await manager.close();index[1]={status:{toolhead:{estimated_print_time:12,print_time:12}},file_position:-1};await writeFile(prefix+'.index.gz',gzipSync(index.map(v=>JSON.stringify(v)+'\x03').join('')));await assert.rejects(MotanLogManager.open(prefix,{start:4}),/file position/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan dataset parser and manager reject unsupported captures, bad parameters and interleaved owner operations',async()=>{
 assert.deepEqual(splitMotanName('a(b(c,d),e)'),['a','b(c,d)','e']);assert.deepEqual(splitMotanParameters('a,b(c,d),e'),['a','b(c,d)','e']);assert.throws(()=>splitMotanName('a(b('),/Malformed/);assert.throws(()=>splitMotanName('a(b))'),/Unbalanced/);
 const dir=await mkdtemp(join(tmpdir(),'motan-owner-')),prefix=join(dir,'capture');try{await managerFixture(prefix);const manager=await MotanLogManager.open(prefix);try{assert.throws(()=>manager.addDataset('accelerometer(missing,x)'),/not in capture/);assert.throws(()=>manager.addDataset('trapq(toolhead,bad)'),/selection/);assert.throws(()=>manager.addDataset('loadcell(l,nope)'),/selection/);assert.throws(()=>manager.addDataset('step_phase(tmc2209 stepper_x,phase)'),/selection/);manager.addDataset('status(heater.temperature)');const pending=manager.sample(11);await assert.rejects(manager.sample(11),/concurrent/);await pending;await assert.rejects(manager.sample(10),/concurrent/);await manager.close();await assert.rejects(manager.sample(12),/closed/);}finally{await manager.close();}await assert.rejects(MotanLogManager.open(prefix,{start:10,maxIndexEntries:1}),/entry limit/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan manager closes an active sample and refuses malformed or missing index ownership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-close-manager-')),prefix=join(dir,'capture');try{await managerFixture(prefix);const manager=await MotanLogManager.open(prefix);manager.addDataset('trapq(toolhead,x)');const pending=manager.sample(10.75).catch(error=>error);await manager.close();assert.match(String(await pending),/closed/);assert.throws(()=>manager.addDataset('status(x)'),/closed/);await manager.close();await writeFile(prefix+'.index.gz',gzipSync(''));await assert.rejects(MotanLogManager.open(prefix),/Empty/);await writeFile(prefix+'.index.gz',gzipSync('{"status":{}}\x03'));await assert.rejects(MotanLogManager.open(prefix),/object/);}finally{await rm(dir,{recursive:true,force:true});}
});
