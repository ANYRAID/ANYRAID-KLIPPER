import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,readdir,readlink,readFile} from 'node:fs/promises';
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
