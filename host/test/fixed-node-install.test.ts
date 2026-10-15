import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {fixedInstallFixture,fixedInstallFixtureUnit,installHash} from './helpers/fixed-install.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {NativeConfigFiles} from '../src/moonraker/native-config-files.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {FixedNodeInstallValidator} from '../src/moonraker/fixed-node-install.ts';
import {ProcessSudoOwner} from '../src/moonraker/sudo-owner.ts';
import type {RpcContext} from '../src/moonraker/rpc.ts';
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){return {username:'operator'};},afterResponse(){}});
async function opened(f:Awaited<ReturnType<typeof fixedInstallFixture>>){const db=await DatabaseStore.open({path:f.databasePath}),files=await NativeConfigFiles.open({root:f.configRoot,writable:['moonraker.conf']}),reader=new ConfigurationReader(await loadConfiguration(f.configFile));let leases=0,restarts=0;const release=files.bindWriter(c=>{assert.equal(leases,0);leases++;return {signal:c.signal,release(){leases--;}};}),sudo=new ProcessSudoOwner(f.backend(),()=>{},async()=>{restarts++;}),validator=new FixedNodeInstallValidator(f.options,reader,files,db,sudo);await validator.initialize(new AbortController().signal);return {db,files,reader,sudo,validator,get leases(){return leases;},get restarts(){return restarts;},async close(){await sudo.close();await validator.close();release();await files.close();await db.close();}};}
test('real fixed-layout consumer installs service and atomic config, keeps legacy version, needs fresh credential-free verification',async()=>{
 const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined,b:typeof a;try{
  // Upstream SQLite conversion leaves old LMDB backup files; their presence
  // cannot invalidate the actively selected, already formatted SQLite store.
  await writeFile(join(f.dataPath,'database/data.mdb'),'retained old backup');a=await opened(f);assert.equal(a.validator.status.state,'pending');assert.throws(()=>a!.validator.assertReady(),/blocks device/);assert.equal(a.sudo.snapshot.sudo_requested,true);
  const result=await a.sudo.setPassword('fixture-password',context()) as any;assert.equal(result.is_restarting,true);assert.equal(a.validator.status.state,'restart_required');assert.throws(()=>a!.validator.assertReady());assert.equal(a.leases,0);assert.equal(a.restarts,1);assert.deepEqual(f.commands,[['daemon-reload']]);
  const config=await readFile(f.configFile,'utf8');assert(!config.includes('config_path'));assert(!config.includes('secrets_path'));assert(config.includes('route_prefix:printer'));const marker=await a.db.get('moonraker','validate_install.node_layout') as any;assert.equal(marker.config_sha256,installHash(config));assert.equal(await a.db.get('moonraker','validate_install.install_version'),0);
  const backups=await a.files.backups('moonraker.conf',context()) as any;assert.equal(backups.backups.length,1);assert.equal(await readFile(join(f.configRoot,backups.backups[0].path),'utf8'),f.original);assert.equal(JSON.parse(await readFile(f.options.recoveryPath,'utf8')).phase,'version-confirmed');
  await a.close();a=undefined;const before=f.counts.privateProbes;b=await opened(f);assert.equal(b.validator.status.state,'ready');b.validator.assertReady();assert.equal(b.sudo.snapshot.sudo_requested,false);assert.equal(f.counts.privateProbes,before,'new process must not authenticate sudo or reuse cached password');assert(f.counts.passwordlessStatus>=2);
 }finally{await b?.close();await a?.close();await f.close();}
});
test('invalid include/DEFAULT/path layouts stay blocked, do not alter configuration or legacy install version',async()=>{
 for(const kind of ['include','default','path'] as const){const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined;try{if(kind==='include'){await writeFile(join(f.configRoot,'more.conf'),`[server]\nconfig_path:${f.configRoot}\n`);await writeFile(f.configFile,'[include more.conf]\n'+f.original);}if(kind==='default')await writeFile(f.configFile,`[DEFAULT]\nconfig_path:${f.configRoot}\n`+f.original);if(kind==='path')await writeFile(f.configFile,f.original.replace(f.logsRoot,'/different/logs'));const before=await readFile(f.configFile);a=await opened(f);assert.equal(a.validator.status.state,'blocked');assert.deepEqual(await readFile(f.configFile),before);assert.equal(await a.db.get('moonraker','validate_install.install_version'),0);await assert.rejects(a.db.get('moonraker','validate_install.node_layout'));assert.deepEqual(f.commands,[]);}finally{await a?.close();await f.close();}}
});
test('early authorization rejection permits explicit retry; changed source and uncertain service/config never complete',async()=>{
 const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined;try{a=await opened(f);await assert.rejects(a.sudo.setPassword('fixture-password',{...context(),authorize(){throw Error('revoked');}}),/revoked/);assert.equal(a.validator.status.state,'pending');await writeFile(f.configFile,f.original+'# edited after snapshot\n');await assert.rejects(a.sudo.setPassword('fixture-password',context()),/callback failed/);assert.equal(a.validator.status.state,'pending');await writeFile(f.configFile,f.original);f.setEffect(async()=>{throw Error('unknown daemon-reload outcome');});await assert.rejects(a.sudo.setPassword('fixture-password',context()),/callback failed/);assert.equal(a.validator.status.state,'blocked');assert.equal(JSON.parse(await readFile(f.options.recoveryPath,'utf8')).phase,'service-started');await assert.rejects(a.db.get('moonraker','validate_install.node_layout'));assert.equal(await a.db.get('moonraker','validate_install.install_version'),0);assert.equal(await readFile(f.configFile,'utf8'),f.original);assert((await lstat(f.unitPath)).isFile());}finally{await a?.close();await f.close();}
});
test('version marker cannot bypass an unknown journal in a fresh process',async()=>{
 const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined;try{a=await opened(f);await a.sudo.setPassword('fixture-password',context());await a.close();a=undefined;const record=JSON.parse(await readFile(f.options.recoveryPath,'utf8'));record.phase='config-confirmed';await writeFile(f.options.recoveryPath,JSON.stringify(record));a=await opened(f);assert.equal(a.validator.status.state,'blocked');assert.throws(()=>a!.validator.assertReady());}finally{await a?.close();await f.close();}
});
test('installation buffer copy is wiped even when authorization fails before a writer lease',async()=>{
 const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined;const original=Buffer.from;let captured:Buffer|undefined;const input=Buffer.from('synthetic private config');
 try{a=await opened(f);Buffer.from=((value:unknown,...args:unknown[])=>{const copy=(original as Function)(value,...args) as Buffer;if(value===input)captured=copy;return copy;}) as typeof Buffer.from;const operation=a.files.installationTransaction('moonraker.conf',input,'0'.repeat(64),{...context(),authorize(){throw Error('revoked before lease');}},async()=>assert.fail('Must not run privileged step'));Buffer.from=original;await assert.rejects(operation,/revoked/);assert(captured);assert(captured.every(b=>b===0));assert.equal(input.toString(),'synthetic private config');assert.equal(a.leases,0);assert.deepEqual(f.commands,[]);}finally{Buffer.from=original;await a?.close();await f.close();}
});
test('present planned batch cannot borrow an old marker as completion, while absent batch preserves confirmed old-layout compatibility',async()=>{
 const f=await fixedInstallFixture();let a:Awaited<ReturnType<typeof opened>>|undefined;try{
  a=await opened(f);await a.sudo.setPassword('fixture-password',context());await a.close();a=undefined;
  const batch=f.options.recoveryPath+'.config-batch.json';await writeFile(batch,JSON.stringify({schema:1,candidateSha256:f.options.candidateSha256,phase:'planned',files:[]}),{mode:0o600});
  a=await opened(f);assert.equal(a.validator.status.state,'pending');assert.throws(()=>a!.validator.assertReady());await a.close();a=undefined;
  const {unlink}=await import('node:fs/promises');await unlink(batch);a=await opened(f);assert.equal(a.validator.status.state,'ready');
 }finally{await a?.close();await f.close();}
});
test('validator close waits an accepted installation while the fixed service executor is still pending',async()=>{
 const f=await fixedInstallFixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let a:Awaited<ReturnType<typeof opened>>|undefined;
 try{a=await opened(f);f.setEffect(async()=>{entered.resolve();await finish.promise;});const installing=a.sudo.setPassword('fixture-password',context());void installing.catch(()=>{});await entered.promise;let closed=false;const closing=a.validator.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);assert.equal(a.leases,1);finish.resolve();await installing;await closing;assert.equal(a.leases,0);assert.equal(JSON.parse(await readFile(f.options.recoveryPath+'.config-batch.json','utf8')).phase,'confirmed');assert.equal(JSON.parse(await readFile(f.options.recoveryPath,'utf8')).phase,'version-confirmed');
 }finally{finish.resolve();await a?.close();await f.close();}
});

test('installation fixtures align scoped and service cgroups without changing product identity checks',async()=>{
 assert.equal(fixedInstallFixtureUnit('0::/user.slice/session.scope\n'),'anyraid.service');
 assert.equal(fixedInstallFixtureUnit('0::/parent.service/actions.runner.fixture.service\n1:name=systemd:/actions.runner.fixture.service\n'),'actions.runner.fixture.service');
 for(const value of ['malformed','0::/bad name.service','0::/one.service\n1:name=systemd:/two.service','0::/ok.service\nmalformed'])assert.throws(()=>fixedInstallFixtureUnit(value),TypeError);
 for(const unit of ['../other.service','group:process.service','bad name.service','scope.scope',''])await assert.rejects(fixedInstallFixture({unit}),TypeError);
 const f=await fixedInstallFixture({unit:'actions.runner.fixture.service'}),backend=f.backend();try{
  assert.equal(f.manifest.unit,'actions.runner.fixture.service');assert.equal(f.options.unit,f.manifest.unit);assert.equal(f.unitPath,join(f.root,'etc/systemd/system',f.manifest.unit));assert.equal(JSON.parse(await readFile(f.manifestPath,'utf8')).unit,f.manifest.unit);
  const installed=await backend.execute('install',Buffer.from('fixture-password'),new AbortController().signal);assert.equal(installed.phase,'installed');assert.equal((await backend.execute('status',undefined,new AbortController().signal)).unitSha256,f.manifest.candidateSha256);assert.equal(JSON.parse(await readFile(join(f.root,'var/lib/anyraid-install-attestations',f.manifest.unit+'.json'),'utf8')).unit,f.manifest.unit);
 }finally{await backend.close();await f.close();}
});
