import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {LegacyConfigCommitOwner} from '../src/moonraker/legacy-config-commit.ts';
import {planLegacyConfiguration} from '../src/moonraker/legacy-config-plan.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex'),candidate='c'.repeat(64);
const ctx=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){return {username:'original-user'};}});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'legacy-config-commit-')),root=join(directory,'config'),externalRoot=join(directory,'include'),state=join(directory,'state');await mkdir(root);await mkdir(externalRoot);await mkdir(state,{mode:0o700});
 const primary=join(root,'moonraker.conf'),external=join(externalRoot,'server.conf'),journal=join(state,'configuration.json');await writeFile(primary,`[include ${external}]\n[database]\ndatabase_path: /legacy/database\n`);await writeFile(external,'[server]\nlog_path: /legacy/logs\nport: 7125\n');
 const before=[await readFile(primary),await readFile(external)],signal=new AbortController().signal,edits=await planLegacyConfiguration(await loadConfiguration(primary),['database.database_path','server.log_path'],signal),files=await NativeConfigFiles.open({root,writable:['moonraker.conf'],installationWritable:[external]}),owner=new LegacyConfigCommitOwner(journal);let leases=0;
 files.bindWriter(c=>{assert.equal(leases,0);leases++;return {signal:c.signal,release(){leases--;}};});
 return {directory,root,state,primary,external,journal,before,signal,edits,files,owner,get leases(){return leases;},async close(){await owner.close();await files.close();await rm(directory,{recursive:true,force:true});}};
}
test('real include saves confirm every file and retain individual original backups in a durable batch decision',async()=>{
 const f=await fixture();let fresh:LegacyConfigCommitOwner|undefined;try{
  assert.equal(await f.owner.inspect([f.primary,f.external],candidate,f.signal),'absent');
  await f.files.installationBatchTransaction(f.edits.map(e=>({filename:e.filename,bytes:e.after,expected:e.beforeSha256})),ctx(),async(signal,commit)=>{await f.owner.plan(f.edits,candidate,signal);await f.owner.commitAll(commit,signal);});
  const decision=JSON.parse(await readFile(f.journal,'utf8'));assert.equal(decision.phase,'confirmed');assert.deepEqual(decision.files.map((e:any)=>e.phase),['confirmed','confirmed']);assert.equal(f.leases,0);
  for(const [index,edit]of f.edits.entries()){assert.equal(sha(await readFile(edit.filename)),edit.afterSha256);assert.equal(sha(await readFile(join(edit.filename.slice(0,edit.filename.lastIndexOf('/')),decision.files[index].backup))),edit.beforeSha256);}
  await f.owner.close();fresh=new LegacyConfigCommitOwner(f.journal);assert.equal(await fresh.inspect([f.primary,f.external],candidate,f.signal),'confirmed');const original=await readFile(f.journal);await assert.rejects(fresh.plan(f.edits,candidate,f.signal),/cannot be replaced/);assert.deepEqual(await readFile(f.journal),original);
 }finally{await fresh?.close();await f.close();}
});
test('second target authorization revoked after admission leaves a durable partial decision and fresh startup cannot replay over a user edit',async()=>{
 const f=await fixture();let fresh:LegacyConfigCommitOwner|undefined;try{
  assert.equal(await f.owner.inspect([f.primary,f.external],candidate,f.signal),'absent');const second=f.edits[1]!,first=f.edits[0]!;let secondChecks=0;
  await assert.rejects(f.files.installationBatchTransaction(f.edits.map(e=>({filename:e.filename,bytes:e.after,expected:e.beforeSha256})),{...ctx(),authorize(method,params){if(method==='machine.sudo.password'&&params.installation_target===second.filename&&++secondChecks===2)throw new ApiError(403,'Second physical target revoked after admission');return {username:'original-user'};}},async(signal,commit)=>{await f.owner.plan(f.edits,candidate,signal);await f.owner.commitAll(commit,signal);}),(e:any)=>e.status===403);
  assert.equal(secondChecks,2);assert.equal(sha(await readFile(first.filename)),first.afterSha256);assert.equal(sha(await readFile(second.filename)),second.beforeSha256);assert.equal(f.leases,0);const original=await readFile(f.journal),decision=JSON.parse(original.toString());assert.equal(decision.phase,'committing');assert.deepEqual(decision.files.map((e:any)=>e.phase),['confirmed','started']);assert(decision.files[0].backup);assert.equal(decision.files[1].backup,null);
  await writeFile(first.filename,'user edited after partial installation\n');await f.owner.close();fresh=new LegacyConfigCommitOwner(f.journal);await assert.rejects(fresh.inspect([f.primary,f.external],candidate,f.signal),/Partial or unknown/);await assert.rejects(fresh.plan(f.edits,candidate,f.signal),/successful recovery inspection/);assert.deepEqual(await readFile(f.journal),original);assert.equal(await readFile(first.filename,'utf8'),'user edited after partial installation\n');assert.equal(sha(await readFile(second.filename)),second.beforeSha256);assert.deepEqual((await readdir(f.state)).sort(),['configuration.json']);
 }finally{await fresh?.close();await f.close();}
});
test('fresh owner cannot plan over a disk decision without inspection and initial publication never overwrites a later record',async()=>{
 const f=await fixture();try{
  const unknown=Buffer.from('{"schema":1,"phase":"unknown"}\n');await writeFile(f.journal,unknown,{mode:0o600});await assert.rejects(f.owner.plan(f.edits,candidate,f.signal),/successful recovery inspection/);await assert.rejects(f.owner.inspect([f.primary,f.external],candidate,f.signal));await assert.rejects(f.owner.plan(f.edits,candidate,f.signal),/successful recovery inspection/);assert.deepEqual(await readFile(f.journal),unknown);
  // A noncooperating ordinary UID writer appears after the absent decision.
  // Kernel directory ownership serializes cooperating owners; exclusive initial
  // publication also preserves this unexpected record instead of renaming over it.
  await rm(f.journal);assert.equal(await f.owner.inspect([f.primary,f.external],candidate,f.signal),'absent');await writeFile(f.journal,unknown,{mode:0o600});await assert.rejects(f.owner.plan(f.edits,candidate,f.signal),(e:any)=>e.code==='EEXIST');assert.deepEqual(await readFile(f.journal),unknown);assert.deepEqual((await readdir(f.state)).sort(),['configuration.json']);
 }finally{await f.close();}
});
test('a 5 MiB admitted include batch can be confirmed and revalidated by a fresh journal owner',async()=>{
 const f=await fixture();let files:NativeConfigFiles|undefined,fresh:LegacyConfigCommitOwner|undefined;
 try{await f.files.close();const original=Buffer.concat([Buffer.from('#'+'.'.repeat(5*1024**2)+'\n'),f.before[0]!]);await writeFile(f.primary,original);const edits=await planLegacyConfiguration(await loadConfiguration(f.primary),['database.database_path','server.log_path'],f.signal);assert(edits.find(e=>e.filename===f.primary)!.after.length>4*1024**2);files=await NativeConfigFiles.open({root:f.root,writable:['moonraker.conf'],installationWritable:[f.external],maxFileBytes:8*1024**2});files.bindWriter(context=>({signal:context.signal,release(){}}));assert.equal(await f.owner.inspect([f.primary,f.external],candidate,f.signal),'absent');await files.installationBatchTransaction(edits.map(e=>({filename:e.filename,bytes:e.after,expected:e.beforeSha256})),ctx(),async(signal,commit)=>{await f.owner.plan(edits,candidate,signal);await f.owner.commitAll(commit,signal);});await f.owner.close();fresh=new LegacyConfigCommitOwner(f.journal);assert.equal(await fresh.inspect([f.primary,f.external],candidate,f.signal),'confirmed');const decision=JSON.parse(await readFile(f.journal,'utf8'));for(const [i,edit]of edits.entries()){assert.equal(sha(await readFile(edit.filename)),edit.afterSha256);assert.equal(sha(await readFile(join(edit.filename.slice(0,edit.filename.lastIndexOf('/')),decision.files[i].backup))),edit.beforeSha256);}}
 finally{await fresh?.close();await files?.close();await f.close();}
});
