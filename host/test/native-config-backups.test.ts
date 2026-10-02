import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,open,rm,chmod,link,unlink,symlink,rename,utimes,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){}});
const status=(code:number)=>(e:unknown)=>e instanceof ApiError&&e.status===code;
async function fixture(){
 const dir=await mkdtemp('/tmp/config-backups-'),root=join(dir,'config');await mkdir(join(root,'parts'),{recursive:true});await writeFile(join(root,'printer.cfg'),'original\n');await writeFile(join(root,'parts','axis.cfg'),'axis\n');
 const files=await NativeConfigFiles.open({root,writable:['printer.cfg','parts/axis.cfg'],maxFileBytes:1024,maxDownloads:1}),gate=new MaintenanceGate();files.bindWriter(c=>({release:gate.acquire(),signal:c.signal}));
 return {dir,root,files,gate,async save(content:string,path='printer.cfg'){return await files.save(path,Buffer.from(content),undefined,context()) as Record<string,any>;},async close(){await files.close();await rm(dir,{recursive:true,force:true});}};
}
test('repeated saves rotate only after replacement and new recovery copy are synchronized',async t=>{
 const f=await fixture();let previous='original\n';try{
  for(let n=0;n<16;n++){const saved=await f.save('version '+n);assert.equal(await readFile(join(f.root,saved.backup),'utf8'),previous);await utimes(join(f.root,saved.backup),new Date(1000+n*1000),new Date(1000+n*1000));previous='version '+n;}
  const first=(await f.files.backups('printer.cfg',context()) as any).backups.at(-1).path;
  const handle=await open(join(f.root,'printer.cfg')),prototype=Object.getPrototypeOf(handle) as FileHandle;await handle.close();const original=prototype.sync;let directorySyncs=0;
  const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if((await this.stat()).isDirectory()&&++directorySyncs===2){assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'version 16');assert.equal((await readdir(f.root)).filter(n=>n.startsWith('.printer.cfg.save-backup-')).length,17);assert.equal(await readFile(join(f.root,first),'utf8'),'original\n');}return original.call(this);});
  const saved=await f.save('version 16');mock.mock.restore();assert.equal(saved.rotatedBackup,first);assert.equal(await readFile(join(f.root,saved.backup),'utf8'),'version 15');
  for(let n=17;n<24;n++)await f.save('version '+n);
  const listed=await f.files.backups('printer.cfg',context()) as any;assert.equal(listed.capacity,16);assert.equal(listed.backups.length,16);assert(!listed.backups.some((b:any)=>b.path===first));assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'version 23');assert.equal(f.files.status.pending,0);assert.equal(f.gate.status.maintenance,false);
 }finally{await f.close();}
});
test('restore fences both versions, keeps previous current bytes, and never applies or starts a print',async()=>{
 const f=await fixture();try{
  const first=await f.save('current'),second=await f.save('latest');
  for(const [current,backup] of [[hash('stale'),hash('original\n')],[hash('latest'),hash('wrong backup')]])await assert.rejects(f.files.restore('printer.cfg',first.backup,current,backup,context()),status(409));
  assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'latest');assert.equal(f.files.status.snapshots.reservations,0);assert.equal(f.gate.status.maintenance,false);
  const result=await f.files.restore('printer.cfg',first.backup,hash('latest'),hash('original\n'),context()) as any;
  assert.equal(result.applied,false);assert.equal(result.restartRequired,true);assert.equal(result.print_started,false);assert.equal(result.print_queued,false);assert.equal(result.restoredFrom,first.backup);assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'original\n');assert.equal(await readFile(join(f.root,result.backup),'utf8'),'latest');assert.equal(await readFile(join(f.root,second.backup),'utf8'),'current');assert.equal(f.files.status.snapshots.reservations,0);
 }finally{await f.close();}
});
test('full capacity restore works from a pinned nested tree and rotates after immutable snapshot consumption',async()=>{
 const f=await fixture();try{
  const first=await f.save('axis 0','parts/axis.cfg');await utimes(join(f.root,first.backup),new Date(0),new Date(0));
  for(let n=1;n<16;n++)await f.save('axis '+n,'parts/axis.cfg');
  await rename(f.root,join(f.dir,'original'));await mkdir(f.root);await writeFile(join(f.root,'printer.cfg'),'replacement');
  const result=await f.files.restore('parts/axis.cfg',first.backup,hash('axis 15'),hash('axis\n'),context()) as any;
  assert.equal(result.rotatedBackup,first.backup);assert.equal(await readFile(join(f.dir,'original','parts','axis.cfg'),'utf8'),'axis\n');assert.equal(await readFile(join(f.dir,'original',result.backup),'utf8'),'axis 15');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'replacement');assert.equal((await f.files.backups('parts/axis.cfg',context()) as any).backups.length,16);
 }finally{await f.close();}
});
test('digest-confirmed deletion retains at least one recovery copy and emits only committed changes',async()=>{
 const f=await fixture(),events:any[]=[];f.files.observeChanges(event=>events.push(event));try{
  const first=await f.save('one'),second=await f.save('two');events.length=0;
  await assert.rejects(f.files.deleteBackup('printer.cfg',first.backup,hash('wrong'),context()),status(409));assert.equal(events.length,0);
  const deleted=await f.files.deleteBackup('printer.cfg',first.backup,hash('original\n'),context()) as any;assert.equal(deleted.removed,true);assert.equal(deleted.directorySynced,true);assert.equal(events.length,1);assert.equal(events[0].action,'delete_file');assert.equal(events[0].item.path,first.backup);
  await assert.rejects(f.files.deleteBackup('printer.cfg',second.backup,hash('one'),context()),status(409));assert.equal(await readFile(join(f.root,second.backup),'utf8'),'one');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'two');assert.equal(events.length,1);assert.equal(f.gate.status.maintenance,false);
 }finally{await f.close();}
});
test('restore and deletion reject foreign paths, permissions, hardlinks, symlinks and activity',async()=>{
 const f=await fixture();try{
  const first=await f.save('one');await f.save('two');const source=join(f.root,first.backup);
  for(const path of ['../outside','parts/'+first.backup,'.printer.cfg.save-backup-invalid'])await assert.rejects(f.files.restore('printer.cfg',path,hash('two'),hash('original\n'),context()));
  await assert.rejects(f.files.restore('read-only.cfg',first.backup,hash('two'),hash('original\n'),context()),status(403));
  await chmod(source,0o644);await assert.rejects(f.files.restore('printer.cfg',first.backup,hash('two'),hash('original\n'),context()),status(409));await assert.rejects(f.files.deleteBackup('printer.cfg',first.backup,hash('original\n'),context()),status(404));await chmod(source,0o600);
  await link(source,join(f.dir,'hardlink'));await assert.rejects(f.files.restore('printer.cfg',first.backup,hash('two'),hash('original\n'),context()),status(409));await unlink(join(f.dir,'hardlink'));
  await unlink(source);await writeFile(join(f.dir,'outside'),'original\n');await symlink('../outside',source);await assert.rejects(f.files.restore('printer.cfg',first.backup,hash('two'),hash('original\n'),context()),status(404));
  const release=f.gate.activity();let downloaded=false;try{await assert.rejects(f.files.restore('printer.cfg',first.backup,hash('two'),hash('original\n'),{...context(),authorize(method){if(method==='server.files.download')downloaded=true;}}));await assert.rejects(f.files.deleteBackup('printer.cfg',first.backup,hash('original\n'),context()));assert.equal(downloaded,false);}finally{release();}
  assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'two');assert.equal(await readFile(join(f.dir,'outside'),'utf8'),'original\n');
 }finally{await f.close();}
});
test('backup queries bound pending authorization and close waits for actual settlement',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();const pending:Promise<unknown>[]=[];
 try{
  for(let n=0;n<4;n++){const p=f.files.backups('printer.cfg',{...context(),authorize(){entered.resolve();return finish.promise;}});void p.catch(()=>{});pending.push(p);}await entered.promise;
  await assert.rejects(f.files.backups('printer.cfg',context()),status(429));let closed=false;const closing=f.files.close().then(()=>closed=true);await new Promise(r=>setImmediate(r));assert.equal(closed,false);await assert.rejects(f.files.backups('printer.cfg',context()),status(503));finish.resolve();for(const p of pending)await assert.rejects(p,status(503));await closing;assert.equal(f.files.status.pending,0);
 }finally{finish.resolve();await Promise.allSettled(pending);await f.close();}
});
test('restore holds the writer through ignored download authorization cancellation and shutdown',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();try{
  const first=await f.save('current'),restore=f.files.restore('printer.cfg',first.backup,hash('current'),hash('original\n'),{...context(),authorize(method){if(method==='server.files.download'){entered.resolve();return finish.promise;}}});void restore.catch(()=>{});await entered.promise;assert.equal(f.gate.status.maintenance,true);
  await assert.rejects(f.files.save('printer.cfg',Buffer.from('other'),undefined,context()),status(409));let closed=false;const closing=f.files.close().then(()=>closed=true);await new Promise(r=>setImmediate(r));assert.equal(closed,false);finish.resolve();await assert.rejects(restore,status(503));await closing;assert.equal(f.gate.status.maintenance,false);assert.equal(f.files.status.snapshots.reservations,0);assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'current');
 }finally{finish.resolve();await f.close();}
});
for(const failedSync of [3,4,5,6])test(`full-capacity sync failure ${failedSync} reports replacement phase and preserves recovery`,async t=>{
 const f=await fixture(),events:any[]=[];f.files.observeChanges(event=>events.push(event));try{
  for(let n=0;n<16;n++)await f.save('value '+n);events.length=0;
  const handle=await open(join(f.root,'printer.cfg')),prototype=Object.getPrototypeOf(handle) as FileHandle;await handle.close();const original=prototype.sync;let calls=0;
  const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(++calls===failedSync)throw Error('Injected capacity sync failure');return original.call(this);});let error:any;
  try{await f.save('changed');assert.fail('Expected uncertainty');}catch(e){error=e;}finally{mock.mock.restore();}
  assert.equal(error.status,500);assert.equal(error.data.phase,failedSync===3?'before-replace':'replaced');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),failedSync===3?'value 15':'changed');assert.equal(events.length,0);
  const listed=await f.files.backups('printer.cfg',context()) as any;if(failedSync===3){assert.equal(listed.backups.length,16);}else{assert.equal(await readFile(join(f.root,error.data.backup),'utf8'),'value 15');assert.equal(listed.backups.length,failedSync===4?17:16);}
  if(failedSync===4){await assert.rejects(f.save('blocked'),status(409));const selected=listed.backups.find((b:any)=>b.path!==error.data.backup).path;await f.files.deleteBackup('printer.cfg',selected,hash(await readFile(join(f.root,selected),'utf8')),context());await f.save('recovered');}
 }finally{await f.close();}
});
test('delete sync failure after unlink returns removed uncertainty and leaves source and remaining copy intact',async t=>{
 const f=await fixture(),events:any[]=[];f.files.observeChanges(event=>events.push(event));try{
  const first=await f.save('one'),second=await f.save('two');events.length=0;const handle=await open(join(f.root,'printer.cfg')),prototype=Object.getPrototypeOf(handle) as FileHandle;await handle.close();const original=prototype.sync;let calls=0;
  const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(++calls===1)throw Error('Injected removal sync');return original.call(this);});try{await assert.rejects(f.files.deleteBackup('printer.cfg',first.backup,hash('original\n'),context()),(e:any)=>e.status===500&&e.data.phase==='removed'&&e.data.backup===first.backup);}finally{mock.mock.restore();}
  assert.equal(events.length,0);assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'two');assert.equal(await readFile(join(f.root,second.backup),'utf8'),'one');assert(!(await readdir(f.root)).includes(first.backup));assert(!(await readdir(f.root)).includes('.printer.cfg.save.lock'));
 }finally{await f.close();}
});
test('backup registration rolls back preceding routes on collision and releases idempotently',async()=>{
 const f=await fixture(),rpc=new JsonRpcDispatcher(),endpoints=new EndpointRegistry(rpc);try{
  const collision=endpoints.register({endpoint:'/printer/host/config/restore',methods:['POST']},()=>null);assert.throws(()=>f.files.registerSave(endpoints));assert.equal(endpoints.allowed('/printer/host/config/save'),undefined);assert.equal(rpc.has('printer.host.config.get_backups'),false);assert.equal(rpc.has('printer.host.config.delete_backups'),false);collision();
  const release=f.files.registerSave(endpoints);assert(rpc.has('printer.host.config.get_backups'));assert(rpc.has('printer.host.config.delete_backups'));assert(rpc.has('printer.host.config.restore'));const result=await endpoints.invoke('/printer/host/config/backups','GET',{path:'printer.cfg'},context()) as any;assert.deepEqual(result.backups,[]);
  await assert.rejects(endpoints.invoke('/printer/host/config/restore','POST',{version:1,path:'printer.cfg'},context()),status(400));await assert.rejects(endpoints.invoke('/printer/host/config/backups','GET',{path:'printer.cfg'}, {...context(),authorize(){throw new ApiError(401,'Denied');}}),status(401));release();release();assert.equal(endpoints.allowed('/printer/host/config/backups'),undefined);
 }finally{await f.close();}
});
