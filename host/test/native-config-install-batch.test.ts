import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,type RpcContext,type Json} from '../src/moonraker/rpc.ts';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){}});
async function fixture(){
 const dir=await mkdtemp(join(process.env.TMPDIR??'/home/dek02/.cache/codex/tmp','config-install-batch-')),root=join(dir,'config'),outside=join(dir,'outside');
 await mkdir(root);await mkdir(outside);const primary=join(root,'shared.conf'),external=join(outside,'shared.conf');await writeFile(primary,'primary before\n');await writeFile(external,'external before\n');
 const files=await NativeConfigFiles.open({root,writable:['shared.conf'],installationWritable:[external]}),gate=new MaintenanceGate();let acquired=0,released=0;
 files.bindWriter(c=>{acquired++;const release=gate.acquire();return {signal:c.signal,release(){released++;release();}};});
 const edits=[{filename:primary,bytes:Buffer.from('primary after\n'),expected:hash('primary before\n')},{filename:external,bytes:Buffer.from('external after\n'),expected:hash('external before\n')}];
 return {dir,root,outside,primary,external,files,gate,edits,get acquired(){return acquired;},get released(){return released;},async close(){await files.close();await rm(dir,{recursive:true,force:true});}};
}
test('one maintenance lease saves approved physical include files without expanding the public root',async()=>{
 const f=await fixture(),targets:string[]=[];try{
  const ctx:RpcContext={...context(),authorize(method,params){if(method==='machine.sudo.password'&&typeof params.installation_target==='string')targets.push(params.installation_target);else assert.notEqual(method,'server.files.upload');}};
  const result=await f.files.installationBatchTransaction(f.edits,ctx,async(_signal,commit)=>{assert.equal(f.gate.status.maintenance,true);return [await commit(0),await commit(1)];});
  assert.equal(result.length,2);assert.deepEqual(targets,[f.primary,f.external,f.primary,f.external]);assert.equal(f.acquired,1);assert.equal(f.released,1);
  for(const [directory,before]of [[f.root,'primary before\n'],[f.outside,'external before\n']] as const){assert.equal(await readFile(join(directory,'shared.conf'),'utf8'),before.replace('before','after'));const backups=(await readdir(directory)).filter(n=>n.startsWith('.shared.conf.save-backup-'));assert.equal(backups.length,1);assert.equal(await readFile(join(directory,backups[0]!),'utf8'),before);}
  assert.equal(f.files.contains(f.external),false);await assert.rejects(f.files.download('/server/files/config/../outside/shared.conf',context(),async()=>assert.fail('External download is forbidden')),(e:any)=>e.status===400);
  assert.deepEqual((await f.files.list({root:'config'},context().signal) as any[]).filter(x=>!x.path.startsWith('.')).map(x=>x.path),['shared.conf']);
 }finally{await f.close();}
});
test('physical installation authorization distinguishes external and public files with the same basename before effects',async()=>{
 const f=await fixture();let ran=false;try{
  const ctx:RpcContext={...context(),authorize(method,params){if(method==='machine.sudo.password'&&params.installation_target===f.external)throw new ApiError(403,'This approved file is outside this caller authority');}};
  await assert.rejects(f.files.installationBatchTransaction(f.edits,ctx,async()=>{ran=true;}),(e:any)=>e.status===403);assert.equal(ran,false);assert.equal(f.acquired,0);assert.equal(await readFile(f.primary,'utf8'),'primary before\n');assert.equal(await readFile(f.external,'utf8'),'external before\n');
  const beforeCalls:string[]=[];await f.files.save('shared.conf',Buffer.from('ordinary upload\n'),f.edits[0]!.expected,{...context(),authorize(method,params){beforeCalls.push(method);assert.equal(params.path,'shared.conf');assert.equal(params.root,'config');}});assert.deepEqual(beforeCalls,['server.files.upload']);
 }finally{await f.close();}
});
for(const finish of ['throw','return','throw-undefined'] as const)test(`accepted unawaited commit is joined before ${finish} releases the lease`,async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let checks=0,settled=false,late:((index:number)=>Promise<Json>)|undefined;const failure=Error('Consumer failed after accepting a write');
 try{
  const ctx:RpcContext={...context(),async authorize(_method,params){if(params.installation_target===f.primary&&++checks===2){entered.resolve();await release.promise;}}};
  const running=f.files.installationBatchTransaction([f.edits[0]!],ctx,async(_signal,commit)=>{late=commit;void commit(0);if(finish==='throw')throw failure;if(finish==='throw-undefined')throw undefined;return 'accepted';});void running.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;await new Promise(r=>setImmediate(r));
  assert.equal(settled,false);assert.equal(f.gate.status.maintenance,true);assert.equal(f.released,0);assert.equal(f.files.status.pending,1);await assert.rejects(late!(0),(e:any)=>e.status===409);await assert.rejects(f.files.save('shared.conf',Buffer.from('overlap'),undefined,context()),(e:any)=>e.status===409);
  release.resolve();if(finish==='return')assert.equal(await running,'accepted');else await running.then(()=>assert.fail('Consumer failure must not become success'),error=>assert.equal(error,finish==='throw'?failure:undefined));
  assert.equal(await readFile(f.primary,'utf8'),'primary after\n');assert.equal(f.released,1);assert.equal(f.gate.status.maintenance,false);assert.equal(f.files.status.pending,0);
 }finally{release.resolve();await f.close();}
});
test('close joins an accepted write whose authorization ignores cancellation and propagates its rejected outcome',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let checks=0,closed=false;
 try{
  const running=f.files.installationBatchTransaction([f.edits[0]!],{...context(),async authorize(_method,params){if(params.installation_target===f.primary&&++checks===2){entered.resolve();await release.promise;}}},async(_signal,commit)=>{void commit(0);});void running.catch(()=>{});await entered.promise;
  const closing=f.files.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);assert.equal(f.released,0);release.resolve();await assert.rejects(running,(e:any)=>e.status===503);await closing;assert.equal(f.released,1);assert.equal(await readFile(f.primary,'utf8'),'primary before\n');
 }finally{release.resolve();await f.close();}
});
