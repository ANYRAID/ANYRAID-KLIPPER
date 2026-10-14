import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ownLegacyExportChild} from '../src/moonraker/legacy-database-export-child.ts';
import {mkdtemp,mkdir,rm,readdir,readlink,readFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareLegacyDatabase,type LegacyDatabaseProcessEvent} from '../src/moonraker/legacy-database-preopen.ts';
const host=fileURLToPath(new URL('..',import.meta.url));
test('cancellation while the real stock LMDB helper is alive joins it and preserves an unknown-stage decision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lmdb-export-cancel-')),source=join(root,'old'),destination=join(root,'database'),abort=new AbortController();let running:Promise<unknown>|undefined,pid:number|undefined;
 try{await mkdir(source,{mode:0o755});await mkdir(destination,{mode:0o755});const fixture=join(root,'fixture'),compiled=spawnSync('cc',['-O2','-pthread','-I'+join(host,'native/lmdb'),join(host,'test/fixtures/legacy-lmdb.c'),join(host,'native/lmdb/mdb.c'),join(host,'native/lmdb/midl.c'),'-o',fixture],{encoding:'utf8',timeout:60000,maxBuffer:1024**2});assert.equal(compiled.status,0,compiled.stderr);const created=spawnSync(fixture,[source,'bulk'],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(created.status,0,created.stderr);
  const started=Promise.withResolvers<number>(),events:LegacyDatabaseProcessEvent[]=[],options={databasePath:join(destination,'moonraker-sql.db'),sourceDirectory:source,sourceQuiescent:true as const,authorization:{issuer:'http://node.invalid:7125'}},observed=prepareLegacyDatabase(options,abort.signal,event=>{events.push(event);if(event.event==='started')started.resolve(event.pid);});running=observed;void observed.catch(started.reject);
  pid=await started.promise;
  process.kill(pid,0);const before=JSON.parse(await readFile(join(destination,'.moonraker-sql.db.legacy-import.json'),'utf8'));assert.equal(before.phase,'preparing');abort.abort(new Error('cancel actual active export'));await assert.rejects(observed,/cancelled|reconciliation/);assert.equal(events.length,2);assert.equal(events[0]!.event,'started');assert.deepEqual(events[1],{event:'closed',pid,status:null,signal:'SIGKILL'});console.log(JSON.stringify({actualHelperPid:pid,aliveBeforeAbort:true,events,targetAbsent:true}));await assert.rejects(readlink('/proc/'+pid+'/exe'),{code:'ENOENT'});assert(!(await readdir(destination)).includes('moonraker-sql.db'));const after=JSON.parse(await readFile(join(destination,'.moonraker-sql.db.legacy-import.json'),'utf8'));assert.equal(after.phase,'preparing');assert((await readdir(destination)).includes(after.stage));await assert.rejects(prepareLegacyDatabase(options,new AbortController().signal),/reconciliation/);
 }finally{abort.abort();await running?.catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('actual buffered LMDB stdout is discarded before one idempotent kill and close join',{timeout:20000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'lmdb-buffered-cancel-')),source=join(root,'old');let directory:Awaited<ReturnType<typeof open>>|undefined,owned:ReturnType<typeof ownLegacyExportChild>|undefined;
 try{await mkdir(source,{mode:0o755});const fixture=join(root,'fixture'),compiled=spawnSync('cc',['-O2','-pthread','-I'+join(host,'native/lmdb'),join(host,'test/fixtures/legacy-lmdb.c'),join(host,'native/lmdb/mdb.c'),join(host,'native/lmdb/midl.c'),'-o',fixture],{encoding:'utf8',timeout:60000,maxBuffer:1024**2});assert.equal(compiled.status,0,compiled.stderr);const created=spawnSync(fixture,[source,'bulk'],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(created.status,0,created.stderr);
  const original=await readFile(join(source,'data.mdb'));directory=await open(source,'r');const child=spawn(join(host,'build/lmdb-read'),[],{stdio:['ignore','pipe','pipe',directory.fd],env:{LANG:'C'}}),events:{code:number|null;signal:NodeJS.Signals|null}[]=[];owned=ownLegacyExportChild(child,exit=>events.push(exit));const iterator=child.stdout![Symbol.asyncIterator]();assert.equal((await iterator.next()).done,false);const deadline=performance.now()+1000;while(child.stdout!.readableLength===0&&performance.now()<deadline)await delay(5);const buffered=child.stdout!.readableLength;assert(buffered>0,'actual unread exporter bytes must be present before cancellation');process.kill(child.pid!,0);
  const first=owned.stop();assert.equal(owned.stop(),first);assert.deepEqual(await first,{code:null,signal:'SIGKILL'});assert.deepEqual(events,[{code:null,signal:'SIGKILL'}]);assert.equal(child.stdout!.destroyed,true);assert.equal(child.stderr!.destroyed,true);await assert.rejects(readlink('/proc/'+child.pid+'/exe'),{code:'ENOENT'});assert.deepEqual(await readFile(join(source,'data.mdb')),original);assert.deepEqual((await readdir(root)).sort(),['fixture','old']);assert.equal(createHash('sha256').update(original).digest('hex'),createHash('sha256').update(await readFile(join(source,'data.mdb'))).digest('hex'));t.diagnostic(JSON.stringify({unreadBytesBeforeStop:buffered,joined:true,closeEvents:events.length,sourceUnchanged:true}));
 }finally{await owned?.stop();await directory?.close();await rm(root,{recursive:true,force:true});}
});

test('failed close observation and failed spawn still settle the actual exporter join',{timeout:5000},async()=>{
 const observation=new Error('injected close observation failure'),child=spawn(join(host,'build/lmdb-read'),[],{stdio:['ignore','pipe','pipe'],env:{LANG:'C'}}),owned=ownLegacyExportChild(child,()=>{throw observation;});child.stdout!.resume();child.stderr!.resume();assert.equal((await owned.closed).code,1);assert.equal(owned.observationError,observation);await assert.rejects(owned.stop(),error=>error===observation);assert.equal(child.stdout!.destroyed,true);assert.equal(child.stderr!.destroyed,true);
 const missing=spawn('/missing-anyraid-legacy-exporter',[],{stdio:['ignore','pipe','pipe']}),failed=ownLegacyExportChild(missing,()=>{});await failed.stop();assert.equal((failed.spawnError as NodeJS.ErrnoException).code,'ENOENT');assert.equal(missing.pid,undefined);assert.equal(missing.stdout!.destroyed,true);assert.equal(missing.stderr!.destroyed,true);
});
