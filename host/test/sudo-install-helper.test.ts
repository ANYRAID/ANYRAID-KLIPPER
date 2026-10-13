import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fixedInstallUnit,runFixedInstallHelper,assertRootPath,type FixedInstallManifest} from '../../scripts/product-install-helper.ts';
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'fixed-install-')),bundle=join(root,'bundle'),dataPath=join(root,'data'),unitPath=join(root,'etc/systemd/system/anyraid.service'),manifestPath=join(root,'manifest.json'),profile=join(root,'profile.mjs');
 await Promise.all([mkdir(bundle),mkdir(join(root,'etc/systemd/system'),{recursive:true}),mkdir(join(root,'var/lib'),{recursive:true}),mkdir(join(dataPath,'systemd'),{recursive:true})]);
 const old='[Service]\nUser=printer\nEnvironmentFile=/old/moonraker.env\n',env='MOONRAKER_ARGS="-m moonraker"\n',metadata='{"product":"test"}\n',source='throw Error("Profile must never execute in helper");\n';
 await Promise.all([writeFile(unitPath,old),writeFile(profile,source),writeFile(join(bundle,'build-info.json'),metadata),writeFile(join(dataPath,'systemd/moonraker.env'),env)]);
 const manifest:FixedInstallManifest={schema:1,unit:'anyraid.service',user:'printer',node:process.execPath,bundle,profile,dataPath,profileSha256:hash(source),bundleManifestSha256:hash(metadata),candidateSha256:'0'.repeat(64),previousUnitSha256:hash(old)};manifest.candidateSha256=hash(fixedInstallUnit(manifest));await writeFile(manifestPath,JSON.stringify(manifest));
 return {root,bundle,dataPath,unitPath,manifestPath,profile,manifest,old,env,state:join(root,'var/lib/anyraid-install/anyraid.service'),async close(){await rm(root,{recursive:true,force:true});}};
}
test('fixed installation consumes actual unit/env files, backs up and regenerates non-root Node unit',async()=>{
 const f=await fixture(),commands:string[][]=[];try{
  const io={root:f.root,async command(args:readonly string[]){commands.push([...args]);}},first=await runFixedInstallHelper(f.manifestPath,'probe',io);assert.equal(first.phase,'unknown');
  const installed=await runFixedInstallHelper(f.manifestPath,'install',io);assert.equal(installed.phase,'installed');assert.equal(await readFile(installed.backup!,'utf8'),f.old);assert.equal(await readFile(installed.envBackup!,'utf8'),f.env);assert.equal(await readFile(join(f.dataPath,'systemd/moonraker.env'),'utf8'),f.env);
  const unit=await readFile(f.unitPath,'utf8');assert.equal(hash(unit),f.manifest.candidateSha256);assert.match(unit,/User=printer/);assert(!unit.includes('EnvironmentFile'));assert(!unit.includes('NoNewPrivileges'));assert.deepEqual(commands,[['daemon-reload']]);
  await runFixedInstallHelper(f.manifestPath,'install',io);assert.equal(commands.length,1);await runFixedInstallHelper(f.manifestPath,'restart',io);assert.deepEqual(commands[1],['--no-block','restart','--','anyraid.service']);assert.equal((await runFixedInstallHelper(f.manifestPath,'status',io)).phase,'installed');
 }finally{await f.close();}
});
test('failed daemon reload preserves durable unknown root receipt and forbids automatic replay',async()=>{
 const f=await fixture();let calls=0;try{const io={root:f.root,async command(){calls++;throw Error('fixed injected failure');}};await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/injected/);assert.equal((await runFixedInstallHelper(f.manifestPath,'status',io)).phase,'unknown');await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/reconciliation/);assert.equal(calls,1);assert.equal(await readFile(join(f.state,'previous.service'),'utf8'),f.old);}finally{await f.close();}
});
test('cross-process-style lock is exclusive, stale lock remains for administrator recovery',async()=>{
 const f=await fixture();try{await mkdir(f.state,{recursive:true});await writeFile(join(f.state,'owner.lock'),'{"pid":99999999}');const io={root:f.root,async command(){assert.fail('No side effects permitted');}};await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/lock requires administrator/);assert.equal(await readFile(join(f.state,'owner.lock'),'utf8'),'{"pid":99999999}');assert.equal(await readFile(f.unitPath,'utf8'),f.old);}finally{await f.close();}
});
test('candidate/old identity drift and state symlink cannot authorize privileged output',async()=>{
 const f=await fixture();try{const io={root:f.root,async command(){assert.fail('No side effects permitted');}};await writeFile(f.unitPath,f.old+'# administrator change\n');await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/approved identity/);assert.equal(await readFile(f.unitPath,'utf8'),f.old+'# administrator change\n');await writeFile(f.unitPath,f.old);await rm(join(f.root,'var/lib/anyraid-install'),{recursive:true,force:true});await mkdir(join(f.root,'elsewhere'));await symlink(join(f.root,'elsewhere'),join(f.root,'var/lib/anyraid-install'));await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/Invalid isolated state base/);assert.equal((await lstat(join(f.root,'var/lib/anyraid-install'))).isSymbolicLink(),true);}finally{await f.close();}
});
test('production trust check rejects service-owned helper before privileged launch; unit fields reject injection',async()=>{
 const f=await fixture();try{await assert.rejects(assertRootPath(f.manifestPath),/Untrusted/);assert.throws(()=>fixedInstallUnit({...f.manifest,user:'root'}),/Invalid/);assert.throws(()=>fixedInstallUnit({...f.manifest,unit:'x.service\nUser=root'}),/Invalid/);await writeFile(f.profile,'different bytes');await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',{root:f.root,async command(){}}),/identity changed/);}finally{await f.close();}
});
test('unknown privileged group cleanup retains owner lock and receipt; confirmed cancellation after replace does not replay',async()=>{
 for(const cleanupUnknown of [false,true]){const f=await fixture();try{const stop=new AbortController(),io={root:f.root,async command(){assert.equal(hash(await readFile(f.unitPath)),f.manifest.candidateSha256);stop.abort();throw Object.assign(Error('cancel after replace'),cleanupUnknown?{code:'HELPER_JOIN_FAILED'}:{});}};await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io,stop.signal),/cancel after replace/);const receipt=JSON.parse(await readFile(join(f.state,'receipt.json'),'utf8'));assert.equal(receipt.phase,'unknown');if(cleanupUnknown)assert((await lstat(join(f.state,'owner.lock'))).isFile());else await assert.rejects(lstat(join(f.state,'owner.lock')),{code:'ENOENT'});await assert.rejects(runFixedInstallHelper(f.manifestPath,'install',io),/reconciliation/);assert.equal(await readFile(join(f.state,'previous.service'),'utf8'),f.old);}finally{await f.close();}}
});
test('two actual helper fixture child processes cannot both install or overwrite the original backup',async()=>{
 const f=await fixture(),marker=join(f.root,'entered'),calls=join(f.root,'calls'),release=join(f.root,'release'),helper=new URL(import.meta.url.endsWith('.ts')?'../../scripts/product-install-helper.ts':'../../scripts/product-install-helper.js',import.meta.url).href;const children:Promise<number|null>[]=[];
 const code=`const fs=await import('node:fs/promises');const {runFixedInstallHelper}=await import(${JSON.stringify(helper)});try{await runFixedInstallHelper(process.argv[1],'install',{root:process.argv[2],async afterLock(){await fs.writeFile(process.argv[4],'entered');const deadline=Date.now()+15000;for(;;){try{await fs.stat(process.argv[5]);break;}catch{}if(Date.now()>deadline)throw Error('Fixture release deadline');await new Promise(r=>setTimeout(r,10));}},async command(){await fs.appendFile(process.argv[3],'reload\\n');}});process.exitCode=0;}catch{process.exitCode=1;}`;
 const child=()=>{const promise=new Promise<number|null>((resolveResult,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',code,f.manifestPath,f.root,calls,marker,release],{stdio:'ignore'});c.once('error',reject);c.once('close',resolveResult);});children.push(promise);return promise;};
 try{const first=child();let entered=false;for(let i=0;i<1000;i++){try{entered=(await readFile(marker,'utf8'))==='entered';if(entered)break;}catch{}await new Promise(r=>setTimeout(r,10));}assert(entered,'first actual helper child must hold lock before receipt/effects');await assert.rejects(lstat(join(f.state,'receipt.json')),{code:'ENOENT'});const second=child();assert.equal(await second,1);await writeFile(release,'release');assert.equal(await first,0);assert.equal(await readFile(calls,'utf8'),'reload\n');assert.equal(await readFile(join(f.state,'previous.service'),'utf8'),f.old);}finally{await writeFile(release,'release').catch(()=>{});await Promise.allSettled(children);await f.close();}
});
