import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,open,rm,symlink,rename,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){}});
async function fixture(){const dir=await mkdtemp('/tmp/native-save-'),root=join(dir,'config');await mkdir(join(root,'parts'),{recursive:true});await writeFile(join(root,'printer.cfg'),'original\n');await writeFile(join(root,'parts','axis.cfg'),'axis\n');const files=await NativeConfigFiles.open({root,writable:['printer.cfg','parts/axis.cfg','alias.cfg'],maxFileBytes:64});const gate=new MaintenanceGate();files.bindWriter(c=>({release:gate.acquire(),signal:c.signal}));return {dir,root,files,gate,async close(){await files.close();await rm(dir,{recursive:true,force:true});}};}
test('scoped optimistic config save keeps exact backup, permissions and pinned nested parent',async()=>{
 const f=await fixture();try{
  const result=await f.files.save('printer.cfg',Buffer.from('new\n'),hash('original\n'),context()) as any;
  assert.equal(result.phase,'replaced');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'new\n');assert.equal(await readFile(join(f.root,result.backup),'utf8'),'original\n');const backup=await open(join(f.root,result.backup));try{assert.equal((await backup.stat()).mode&0o777,0o600);}finally{await backup.close();}
  await rename(f.root,join(f.dir,'original'));await mkdir(f.root);await writeFile(join(f.root,'printer.cfg'),'replacement');
  await f.files.save('parts/axis.cfg',Buffer.from('changed axis'),hash('axis\n'),context());assert.equal(await readFile(join(f.dir,'original','parts','axis.cfg'),'utf8'),'changed axis');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'replacement');
  await assert.rejects(f.files.save('printer.cfg',Buffer.from('stale'),hash('original\n'),context()),(e:any)=>e.status===409);assert.equal(await readFile(join(f.dir,'original','printer.cfg'),'utf8'),'new\n');
 }finally{await f.close();}
});
test('read-only, symlink, invalid bytes, size, authorization and activity reject before replacement',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.dir,'outside'),'outside');await symlink('../outside',join(f.root,'alias.cfg'));
  for(const [name,bytes,status] of [['../outside',Buffer.from('x'),400],['other.cfg',Buffer.from('x'),403],['alias.cfg',Buffer.from('x'),409],['printer.cfg',Buffer.from([255]),400],['printer.cfg',Buffer.from([0]),400],['printer.cfg',Buffer.alloc(65),413]] as const)await assert.rejects(f.files.save(name,bytes,undefined,context()),(e:any)=>e.status===status,name);
  await assert.rejects(f.files.save('printer.cfg',Buffer.from('x'),undefined,{...context(),authorize(){throw new ApiError(401,'Denied');}}),(e:any)=>e.status===401);
  const release=f.gate.activity();try{await assert.rejects(f.files.save('printer.cfg',Buffer.from('x'),undefined,context()));}finally{release();}
  assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'original\n');assert.equal(await readFile(join(f.dir,'outside'),'utf8'),'outside');assert.equal(f.gate.status.maintenance,false);
 }finally{await f.close();}
});
test('pending authorization blocks a second save and close waits actual cancellation settlement',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();try{
  const save=f.files.save('printer.cfg',Buffer.from('x'),undefined,{...context(),authorize(){entered.resolve();return finish.promise;}});void save.catch(()=>{});await entered.promise;
  await assert.rejects(f.files.save('printer.cfg',Buffer.from('y'),undefined,context()),(e:any)=>e.status===409);
  let closed=false;const close=f.files.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);finish.resolve();await assert.rejects(save,(e:any)=>e.status===503);await close;assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'original\n');assert.equal(f.files.status.pending,0);
 }finally{finish.resolve();await f.close();}
});
for(const failedSync of [1,2,3,4])test(`config sync failure ${failedSync} preserves pre-replace source or reports durable uncertainty`,async t=>{
 const f=await fixture(),handle=await open(join(f.root,'printer.cfg')),prototype=Object.getPrototypeOf(handle) as FileHandle;await handle.close();const original=prototype.sync;let calls=0;const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(++calls===failedSync)throw Error('Injected sync failure');return original.call(this);});try{
  let error:any;try{await f.files.save('printer.cfg',Buffer.from('new'),hash('original\n'),context());assert.fail('Must fail');}catch(e){error=e;}
  assert.equal(error.status,500);assert.equal(error.data.phase,failedSync===4?'replaced':'before-replace');assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),failedSync===4?'new':'original\n');
  const artifacts=(await readdir(f.root)).filter(n=>n.startsWith('.'));if(failedSync===4){assert.equal(artifacts.length,1);assert.equal(await readFile(join(f.root,artifacts[0]),'utf8'),'original\n');}else assert.deepEqual(artifacts,[]);
 }finally{mock.mock.restore();await f.close();}
});
test('external edit during directory sync conflicts and is never overwritten',async t=>{
 const f=await fixture(),handle=await open(join(f.root,'printer.cfg')),prototype=Object.getPrototypeOf(handle) as FileHandle;await handle.close();const original=prototype.sync;let edited=false;const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(!edited&&(await this.stat()).isDirectory()){edited=true;await writeFile(join(f.root,'printer.cfg'),'external');}return original.call(this);});try{await assert.rejects(f.files.save('printer.cfg',Buffer.from('new'),undefined,context()),(e:any)=>e.status===409);assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'external');assert.deepEqual((await readdir(f.root)).filter(n=>n.startsWith('.')),[]);}finally{mock.mock.restore();await f.close();}
});
test('backup capacity rejects further writes while retaining current source and recovery copies',async()=>{
 const f=await fixture();try{for(let n=0;n<16;n++)await writeFile(join(f.root,`.printer.cfg.save-backup-${n}`),'backup');await assert.rejects(f.files.save('printer.cfg',Buffer.from('x'),undefined,context()),(e:any)=>e.status===409);assert.equal(await readFile(join(f.root,'printer.cfg'),'utf8'),'original\n');assert.equal((await readdir(f.root)).filter(n=>n.startsWith('.')).length,16);}finally{await f.close();}
});
