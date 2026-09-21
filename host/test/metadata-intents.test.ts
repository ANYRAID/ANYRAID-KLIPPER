import {spawn} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,chmod,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataScanIntents,MetadataIntentWriteError} from '../src/moonraker/metadata-intents.ts';
const signal=new AbortController().signal;
async function fixture(){const path=await mkdtemp(join(tmpdir(),'metadata-intents-'));return {path,close:()=>rm(path,{recursive:true,force:true})};}
test('durable scan intents survive reopen and require explicit acknowledgment',async()=>{
 const f=await fixture();let journal=await MetadataScanIntents.open(f.path);try{
  const a=await journal.begin('folder/part.gcode',signal),b=await journal.begin('folder/part.gcode',signal);assert.notEqual(a.bundleId,b.bundleId);assert.equal(a.bundleId,'thumb-'+a.id.slice(5));assert.equal(Object.isFrozen(a),true);
  const before=journal.unresolved();assert.equal(before.length,2);assert.equal(Object.isFrozen(before),true);await journal.close();journal=await MetadataScanIntents.open(f.path);assert.deepEqual([...journal.unresolved()].sort((a,b)=>a.id.localeCompare(b.id)),[a,b].sort((a,b)=>a.id.localeCompare(b.id)));
  await assert.rejects(journal.acknowledge(a,signal),/stale/);assert.equal(journal.status.faulted,false);await journal.acknowledge(journal.unresolved().find(v=>v.id===a.id)!,signal);assert.equal(journal.unresolved().length,1);assert.equal(before.length,2);await journal.close();journal=await MetadataScanIntents.open(f.path);assert.deepEqual(journal.unresolved().map(v=>v.id),[b.id]);
 }finally{await journal.close();await f.close();}
});
test('admission limits, preabort and invalid filenames do not poison valid intent writes',async()=>{
 const f=await fixture(),journal=await MetadataScanIntents.open(f.path,{maxIntents:1,maxPending:1});try{
  for(const filename of ['','/absolute','a/../b','a//b','bad\0name','a'.repeat(4097)])await assert.rejects(journal.begin(filename,signal),/filename/);
  await assert.rejects(journal.begin('p.gcode',AbortSignal.abort(new Error('cancel'))),/cancel/);
  const pending=journal.begin('p.gcode',signal);await assert.rejects(journal.begin('other.gcode',signal),/queue/);const record=await pending;await assert.rejects(journal.begin('other.gcode',signal),/capacity/);assert.equal(journal.status.faulted,false);
  await assert.rejects(journal.acknowledge({...record},signal),/stale/);await assert.rejects(journal.acknowledge(record,AbortSignal.abort(new Error('cancel ack'))),/cancel ack/);assert.equal(journal.unresolved().length,1);await journal.acknowledge(record,signal);assert.equal(journal.status.staging.reservations,0);assert.equal(journal.unresolved().length,0);
 }finally{await journal.close();await f.close();}
});
test('close drains accepted writes and releases the private directory lock',async()=>{
 const f=await fixture(),journal=await MetadataScanIntents.open(f.path);try{
  await assert.rejects(MetadataScanIntents.open(f.path),/lock|busy|temporarily/i);
  const pending=journal.begin('part.gcode',signal),closing=journal.close(),record=await pending;await closing;await assert.rejects(journal.begin('other.gcode',signal),/closed/);
  const reopened=await MetadataScanIntents.open(f.path);try{assert.equal(reopened.unresolved()[0].id,record.id);}finally{await reopened.close();}
 }finally{await journal.close();await f.close();}
});
test('digest corruption prevents intent recovery and leaves evidence untouched',async()=>{
 const f=await fixture(),journal=await MetadataScanIntents.open(f.path);try{
  await journal.begin('part.gcode',signal);await journal.close();const file=(await readdir(f.path)).find(name=>name.endsWith('.gcode'))!,path=join(f.path,file),bytes=await readFile(path);bytes[0]^=1;await chmod(path,0o600);await writeFile(path,bytes);
  await assert.rejects(MetadataScanIntents.open(f.path),/digest|hash/i);assert.deepEqual(await readFile(path),bytes);
 }finally{await journal.close();await f.close();}
});
test('JSON escaping of valid long filenames fits the bounded durable format',async()=>{
 const f=await fixture(),journal=await MetadataScanIntents.open(f.path);try{const record=await journal.begin('\u0001'.repeat(4096),signal);await journal.close();const recovered=await MetadataScanIntents.open(f.path);try{assert.equal(recovered.unresolved()[0].filename,record.filename);}finally{await recovered.close();}}finally{await journal.close();await f.close();}
});

test('receipt sync uncertainty fences mutations and preserves the original intent for recovery',async()=>{
 const f=await fixture();let journal=await MetadataScanIntents.open(f.path);const probe=await open('/dev/null','r'),prototype=Object.getPrototypeOf(probe),original=prototype.sync;await probe.close();let calls=0,saved:import('../src/moonraker/metadata-intents.ts').MetadataScanIntent|undefined;
 try{
  prototype.sync=function(...args:unknown[]){if(++calls===4)return Promise.reject(new Error('injected receipt directory sync failure'));return Reflect.apply(original,this,args);};
  try{await assert.rejects(journal.begin('part.gcode',signal),(error:any)=>{assert.ok(error instanceof MetadataIntentWriteError);saved=error.intent;return /requires recovery/.test(error.message);});}finally{prototype.sync=original;}
  assert.equal(calls,4);assert.equal(journal.status.faulted,true);assert.throws(()=>journal.unresolved(),/recovered/);await assert.rejects(journal.begin('other.gcode',signal),/recovery/);await journal.close();journal=await MetadataScanIntents.open(f.path);assert.deepEqual(journal.unresolved(),[saved]);await journal.acknowledge(journal.unresolved()[0],signal);assert.equal(journal.unresolved().length,0);
 }finally{prototype.sync=original;await journal.close();await f.close();}
});

test('intent remains discoverable after its owner is killed without graceful close',async()=>{
 const f=await fixture();try{
  const moduleUrl=new URL('../src/moonraker/metadata-intents.ts',import.meta.url).href;
  const code=`import {MetadataScanIntents} from ${JSON.stringify(moduleUrl)};const owner=await MetadataScanIntents.open(process.argv[1]);const intent=await owner.begin('crashed.gcode',new AbortController().signal);await new Promise(resolve=>process.stdout.write(JSON.stringify(intent),resolve));process.kill(process.pid,'SIGKILL');`;
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,f.path],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);child.on('error',reject);child.on('close',(code,signal)=>{if(code!==null&&code!==0)reject(new Error(errors));else resolve({code,signal,output});});});
  assert.equal(result.signal,'SIGKILL');const expected=JSON.parse(result.output),recovered=await MetadataScanIntents.open(f.path);try{assert.deepEqual(recovered.unresolved(),[expected]);assert.equal(recovered.status.staging.reservations,0);}finally{await recovered.close();}
 }finally{await f.close();}
});
