import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync,inflateRawSync,constants} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
import {MotanLogReader} from '../src/motan/log-reader.ts';
test('Motan full-flush positions restart Node reader without changing integer or float lexemes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-log-')),path=join(dir,'capture.json.gz'),writer=await MotanLogWriter.open(path),first=Buffer.from('{"clock":9007199254740993,"x":1.0000000000000002}'),second=Buffer.from('{"clock":9007199254740995,"x":-0.00000000000000001}');
 try{assert.equal(await writer.flush(),0);await writer.addData(first);const at=await writer.flush();assert.equal((await stat(path)).size,at);assert.equal(gunzipSync(await readFile(path),{finishFlush:constants.Z_SYNC_FLUSH}).toString(),first+'\x03');await writer.addData(second);await writer.close();const data=await readFile(path);assert.equal(gunzipSync(data).toString(),first+'\x03'+second+'\x03');assert.equal(inflateRawSync(data.subarray(at)).toString(),second+'\x03');
  const reader=await MotanLogReader.open(path);
  try{assert.deepEqual(await reader.pullMessages(),[{clock:9007199254740993n,x:1.0000000000000002},{clock:9007199254740995n,x:-.00000000000000001}]);await reader.seek(at);assert.deepEqual(await reader.pullMessage(),{clock:9007199254740995n,x:-.00000000000000001});assert.equal(await reader.pullMessage(),null);}finally{await reader.close();}
  assert.equal(writer.status.pending,0);assert.equal(writer.status.rawPosition,first.length+second.length+2);
 }finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan incompressible chunks drain before index publication across many full flushes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-drain-')),path=join(dir,'log'),writer=await MotanLogWriter.open(path,{maxRecordBytes:2*1024**2,maxPendingBytes:3*1024**2,maxPending:1});
 try{const records:Buffer[]=[],offsets:number[]=[];for(let i=0;i<8;i++){const record=Buffer.from(JSON.stringify({i,data:randomBytes(500000).toString('base64')}));records.push(record);if(i%2)offsets.push(await writer.addRecordsAndFlush([record]));else{await writer.addData(record);offsets.push(await writer.flush());}assert.equal((await stat(path)).size,offsets.at(-1));}await writer.close();const data=await readFile(path);assert.deepEqual(gunzipSync(data),Buffer.concat(records.flatMap(r=>[r,Buffer.from([3])])));for(let i=0;i<offsets.length-1;i++)assert.deepEqual(inflateRawSync(data.subarray(offsets[i])),Buffer.concat(records.slice(i+1).flatMap(r=>[r,Buffer.from([3])])));
 }finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan bounded queue snapshots caller buffers, serializes flush and drains accepted work on close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-queue-')),path=join(dir,'log'),writer=await MotanLogWriter.open(path,{maxRecordBytes:20,maxPendingBytes:20,maxPending:2});
 try{const source=Buffer.from('{"x":1}'),a=writer.addData(source),b=writer.flush();source.fill(120);await assert.rejects(writer.addData(Buffer.from('x')),/capacity/);const closing=writer.close();await assert.rejects(writer.addData(Buffer.from('late')),/closed/);await Promise.all([a,b,closing]);assert.equal(gunzipSync(await readFile(path)).toString(),'{"x":1}\x03');assert.equal(writer.status.pendingBytes,0);assert.equal(writer.status.pending,0);assert.equal(writer.close(),closing);}finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan empty captures preserve old empty-file behavior, reject delimiters and never overwrite existing captures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-empty-')),path=join(dir,'log'),writer=await MotanLogWriter.open(path,{maxRecordBytes:3});try{await assert.rejects(writer.addData(Buffer.from([3])),/delimiter/);await assert.rejects(writer.addData(Buffer.alloc(4)),/size/);assert.equal(writer.status.failed,false);await writer.close();assert.equal((await stat(path)).size,0);await writeFile(path,'keep');await assert.rejects(MotanLogWriter.open(path),{code:'EEXIST'});assert.equal(await readFile(path,'utf8'),'keep');}finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan batches preserve every record and index boundary while enforcing total admission bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-batch-')),path=join(dir,'log'),writer=await MotanLogWriter.open(path,{maxRecordBytes:10,maxPendingBytes:12});try{await assert.rejects(writer.addRecords([Buffer.alloc(6),Buffer.alloc(6)]),/capacity/);await assert.rejects(writer.addRecords([]),/count/);await writer.addRecords([Buffer.from('1'),Buffer.from('2'),Buffer.from('3')]);const at=await writer.flush();await writer.addRecords([Buffer.from('4'),Buffer.from('5')]);await writer.close();const data=await readFile(path);assert.equal(gunzipSync(data).toString(),'1\x032\x033\x034\x035\x03');assert.equal(inflateRawSync(data.subarray(at)).toString(),'4\x035\x03');}finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
test('Motan disk failure is latched, queued work fails and close releases the file instead of claiming a valid capture',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-fail-'));try{const code=`import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {MotanLogWriter} from ${JSON.stringify(new URL('../src/motan/log-writer.ts',import.meta.url).href)};process.on('SIGXFSZ',()=>{});const writer=await MotanLogWriter.open(process.argv[1]);const first=writer.addRecordsAndFlush([Buffer.from(JSON.stringify({data:randomBytes(100000).toString('base64')}))]),second=writer.flush();const results=await Promise.allSettled([first,second]);assert.equal(results.every(r=>r.status==='rejected'),true);assert.equal(writer.status.failed,true);await assert.rejects(writer.addData(Buffer.from('1')));await assert.rejects(writer.close());assert.equal(writer.status.pending,0);console.log('failed cleanly');`;
  for(const combined of [false,true]){const script=combined?code:code.replace("addRecordsAndFlush([Buffer.from(JSON.stringify({data:randomBytes(100000).toString('base64')}))])", "addData(Buffer.from(JSON.stringify({data:randomBytes(100000).toString('base64')})))");assert.equal(execFileSync('prlimit',['--fsize=1024:1024',process.execPath,'--input-type=module','-e',script,join(dir,String(combined))],{encoding:'utf8',timeout:5000}).trim(),'failed cleanly');}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('combined batch flush snapshots inputs, occupies one queue slot and closes after publishing a restart boundary',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-combined-')),path=join(dir,'log'),writer=await MotanLogWriter.open(path,{maxRecordBytes:20,maxPendingBytes:20,maxPending:1});
 try{
  const source=Buffer.from('{"x":1.0}');
  await assert.rejects(writer.addRecordsAndFlush([]),/count/);
  await assert.rejects(writer.addRecordsAndFlush([Buffer.from([3])]),/delimiter/);
  const boundary=writer.addRecordsAndFlush([source]);source.fill(120);
  assert.equal(writer.status.pending,1);assert.equal(writer.status.pendingBytes,10);
  await assert.rejects(writer.flush(),/capacity/);
  const at=await boundary;assert.equal((await stat(path)).size,at);
  assert.equal(gunzipSync(await readFile(path),{finishFlush:constants.Z_SYNC_FLUSH}).toString(),'{"x":1.0}\x03');
  const next=writer.addRecordsAndFlush([Buffer.from('2'),Buffer.from('3')]),closing=writer.close();
  await assert.rejects(writer.addRecordsAndFlush([Buffer.from('4')]),/closed/);
  const end=await next;await closing;
  const data=await readFile(path);assert.equal(gunzipSync(data).toString(),'{"x":1.0}\x032\x033\x03');
  assert.equal(inflateRawSync(data.subarray(at)).toString(),'2\x033\x03');assert.equal(inflateRawSync(data.subarray(end)).length,0);
  assert.equal(writer.status.pending,0);assert.equal(writer.status.pendingBytes,0);assert.equal(writer.status.rawPosition,14);
 }finally{await writer.close();await rm(dir,{recursive:true,force:true});}
});
