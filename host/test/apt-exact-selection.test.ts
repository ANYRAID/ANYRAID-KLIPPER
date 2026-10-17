import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AptPackageProvider,aptPackageVersion,parseAptPolicyCandidates} from '../src/moonraker/apt-package-provider.ts';
import type {AptMutationJournal,AptMutationState} from '../src/moonraker/apt-package-provider.ts';
import {AptPackageError,ProcessAptCommandExecutor} from '../src/moonraker/apt-command-executor.ts';
import type {AptCommandExecutor,AptCommandRequest,AptOperationContext} from '../src/moonraker/apt-command-executor.ts';
const commands={apt:'/usr/bin/apt',aptGet:'/usr/bin/apt-get',aptCache:'/usr/bin/apt-cache'};
const realApt=process.platform==='linux'&&(await Promise.allSettled([...Object.values(commands),'/usr/bin/apt-config'].map(path=>access(path,constants.X_OK)))).every(result=>result.status==='fulfilled');
const realOptions={timeout:30000,skip:realApt?false:'Linux and executable apt/apt-get/apt-cache/apt-config required'};
const context=():AptOperationContext=>({signal:AbortSignal.timeout(15000),authorize:()=>{}});
const errorCode=(code:string)=>(error:unknown)=>error instanceof AptPackageError&&error.code===code;
const policy=(name:string,candidate='1',table=candidate)=>`${name}:\n  Installed: (none)\n  Candidate: ${candidate}\n  Version table:\n     ${table} 500\n        500 fixture Packages\n`;
function memoryJournal(initial:unknown=null){let value=structuredClone(initial);const writes:AptMutationState[]=[];const journal:AptMutationJournal={async load(){return structuredClone(value);},async save(row){writes.push(structuredClone(row));value=structuredClone(row);}};return {journal,writes,value:()=>value};}

test('exact version grammar is bounded and cannot carry request selectors or action syntax',()=>{
 for(const value of ['1','2:1.2.3+dfsg-4ubuntu5~test1','1~rc1','0.0+git20261018','1-2-3'])assert.equal(aptPackageVersion(value),true,value);
 for(const value of ['',null,1,'(none)','--yes','1;id','1/unstable','1=2','1*','1|2','1 2','1\n2','bad','1:','x:1','1.2:3','1-','1-2:3','1'.repeat(257)])assert.equal(aptPackageVersion(value),false,String(value));
});

test('Candidate selection follows APT pin policy and preserves request order/duplicates',()=>{
 const output='g++:\n  Installed: (none)\n  Candidate: 1\n  Version table:\n     9 500\n        500 fixture Packages\n     1 1001\n        500 fixture Packages\n'+policy('name-','2:1.0-1');
 assert.deepEqual(parseAptPolicyCandidates(output,['name-','g++','name-']),[{name:'name-',version:'2:1.0-1'},{name:'g++',version:'1'},{name:'name-',version:'2:1.0-1'}]);
});

test('malformed, missing, unsafe and absent candidate metadata is rejected',()=>{
 for(const output of ['',policy('g++',''),policy('g++','1;id'),policy('g++','1/unstable'),policy('g++','1=2'),policy('g++','1','2'),policy('g++')+policy('g++'),policy('wrong'),policy('g++').replace('  Candidate: 1\n',''),policy('g++').replace('  Version table:\n',''),policy('g++').replace('  Candidate: 1','  Candidate: 1\n  Candidate: 1'),'x'.repeat(4097)])assert.throws(()=>parseAptPolicyCandidates(output,['g++']),errorCode('output'));
 assert.throws(()=>parseAptPolicyCandidates('g++:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n',['g++']),errorCode('unavailable'));
 assert.throws(()=>parseAptPolicyCandidates(policy('g++'),['g++=1']),errorCode('invalid'));
});

async function fake(t:test.TestContext,candidateOutput=policy('g++')+policy('name-')+policy('plain')){
 const calls:AptCommandRequest[]=[],journal=memoryJournal();const executor:AptCommandExecutor={async run(request){calls.push(request);return {stdout:request.args.includes('search')?'g++ - Compiler\nname- - Trailing minus\nplain - Plain\n':request.args.includes('policy')?candidateOutput:'',stderr:'',exitCode:0};}};
 const provider=new AptPackageProvider({commands,executor,journal:journal.journal});t.after(()=>provider.close());await provider.initialize(context());return {provider,calls,journal};
}

test('install records exact policy targets before dispatch and cannot expose public selectors',async t=>{
 const f=await fake(t);assert.deepEqual(await f.provider.resolvePackages(['name-','missing','g++','name-'],context()),['name-','g++','name-']);
 assert.deepEqual(await f.provider.installPackages(['name-','missing','g++','name-','plain'],context()),['name-','g++','name-','plain']);
 const query=f.calls.find(call=>call.args.includes('policy'))!;assert.deepEqual(query.args,['policy','name-','g++','plain']);const install=f.calls.find(call=>call.effect==='install')!;
 assert.deepEqual(install.args.slice(-7),['install','--yes','--no-remove','name-=1','g++=1','name-=1','plain=1']);assert.equal(f.journal.writes[0].state,'pending');const pending=f.journal.writes[0];assert.deepEqual(pending.exactTargets,[{name:'name-',version:'1'},{name:'g++',version:'1'},{name:'name-',version:'1'},{name:'plain',version:'1'}]);
 const count=f.calls.length;for(const name of ['g++=9','g++:amd64','g++/unstable','g++*'])await assert.rejects(f.provider.installPackages([name],context()),errorCode('invalid'));assert.equal(f.calls.length,count);
});

test('candidate failures never persist install intent or dispatch mutation',async t=>{
 for(const output of ['',policy('g++','1;id'),policy('g++','1','2'),'g++:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n']){
  const f=await fake(t,output);await assert.rejects(f.provider.installPackages(['g++'],context()));assert.equal(f.journal.writes.length,0);assert.equal(f.calls.some(call=>call.effect==='install'),false);
 }
});

test('exact-target journals preserve legacy interrupted records and validate new name/version bindings',async t=>{
 const legacy={schema:1,state:'interrupted',id:'01234567-0123-4123-8123-012345678901',operation:'install',packages:['g++'],startedAt:1};
 for(const record of [legacy,{...legacy,exactTargets:[{name:'g++',version:'1'}]}]){const provider=new AptPackageProvider({commands,executor:{async run(){return {stdout:'',stderr:'',exitCode:0};}},journal:memoryJournal(record).journal});t.after(()=>provider.close());await provider.initialize(context());assert.equal(provider.status.mutation.state,'interrupted');await assert.rejects(provider.installPackages(['g++'],context()),errorCode('interrupted'));}
 for(const exactTargets of [[{name:'g+++',version:'1'}],[{name:'g++',version:'1=9'}],[],[{name:'g++',version:'1',extra:true}]]){const provider=new AptPackageProvider({commands,executor:{async run(){return {stdout:'',stderr:'',exitCode:0};}},journal:memoryJournal({...legacy,exactTargets}).journal});t.after(()=>provider.close());await assert.rejects(provider.initialize(context()),errorCode('journal'));}
});

const packageRecord=(name:string,version='1',extra='')=>`Package: ${name}\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.invalid>\nDescription: Synthetic ${name}\nFilename: nonexistent-${name}.deb\nSize: 1\nSHA256: ${'0'.repeat(64)}\n${extra}\n`;
const installedRecord=(name:string)=>`Package: ${name}\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: Fixture <fixture@example.invalid>\nArchitecture: amd64\nVersion: 1\nDescription: Fixture installed state\n\n`;
async function privateApt(t:test.TestContext,index:string,installed='',preferences=''){
 const root=await mkdtemp(join(tmpdir(),'apt-exact-test-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const path of ['etc/apt','var/lib/apt/lists/partial','var/lib/dpkg','var/cache/apt/archives/partial','var/log/apt','repo'])await mkdir(join(root,path),{recursive:true});
 await writeFile(join(root,'repo/Packages'),index);await writeFile(join(root,'etc/apt/sources.list'),`deb [trusted=yes] file:${root}/repo ./\n`);await writeFile(join(root,'etc/apt/preferences'),preferences);const statusPath=join(root,'var/lib/dpkg/status');await writeFile(statusPath,installed);
 const configurationFile=join(root,'early.conf');await writeFile(configurationFile,`Dir "${root}";\nDir::Etc "${root}/etc/apt";\nDir::Etc::main "/dev/null";\nDir::Etc::parts "-";\n`);
 const aptConfiguration={'Dir':root,'Dir::State':'var/lib/apt','Dir::State::status':statusPath,'Dir::State::lists':'lists','Dir::Cache':'var/cache/apt','Dir::Cache::archives':'archives','Dir::Etc':'etc/apt','Dir::Etc::sourcelist':'sources.list','Dir::Etc::sourceparts':'-','Dir::Etc::main':'/dev/null','Dir::Etc::parts':'-','Dir::Log':'var/log/apt','APT::Architecture':'amd64','Acquire::Languages':'none'};
 const processExecutor=new ProcessAptCommandExecutor();t.after(()=>processExecutor.close());const env={PATH:'/usr/bin:/bin',LC_ALL:'C',APT_CONFIG:configurationFile};const dumped=await processExecutor.run({command:'/usr/bin/apt-config',args:['dump'],env,timeoutMs:10000,maxOutputBytes:65536,effect:'query',...context()});assert.ok(!/^(?:APT::Update|DPkg)::(?:Pre|Post)-Invoke/mu.test(dumped.stdout));
 const calls:AptCommandRequest[]=[],simulations:Array<{args:readonly string[];stdout:string}>=[],journal=memoryJournal();let beforeMutation:((request:AptCommandRequest)=>Promise<void>)|undefined;
 const executor:AptCommandExecutor={async run(request){calls.push(request);if(request.effect==='install'||request.effect==='upgrade'){await beforeMutation?.(request);const result=await processExecutor.run({...request,args:['--simulate',...request.args]});simulations.push({args:request.args,stdout:result.stdout});return result;}return processExecutor.run(request);}};
 const provider=new AptPackageProvider({commands,configurationFile,aptConfiguration,executor,journal:journal.journal});t.after(()=>provider.close());await provider.initialize(context());
 return {root,provider,processExecutor,calls,simulations,journal,statusPath,env,setBeforeMutation(fn:(request:AptCommandRequest)=>Promise<void>){beforeMutation=fn;},async unchanged(){assert.equal(await readFile(statusPath,'utf8'),installed);}};
}

test('real APT exact candidates install original colliding names and honor the pinned lower version',realOptions,async t=>{
 const names=['g++','g+++','name-','name-+','plain','plain+'];const f=await privateApt(t,names.map(name=>packageRecord(name)).join('')+packageRecord('fixture-pin','1')+packageRecord('fixture-pin','9'),'','Package: fixture-pin\nPin: version 1\nPin-Priority: 1001\n');
 assert.deepEqual(await f.provider.installPackages(['g++','name-','plain','fixture-pin','g++','missing'],context()),['g++','name-','plain','fixture-pin','g++']);
 const simulated=f.simulations[0];assert.ok(simulated.args.includes('--no-remove'));assert.deepEqual(simulated.args.slice(-5),['g++=1','name-=1','plain=1','fixture-pin=1','g++=1']);
 const selected=[...simulated.stdout.matchAll(/^Inst (\S+) \((\S+)/gmu)].map(match=>[match[1],match[2]]);assert.deepEqual(selected.sort(),[['g++','1'],['name-','1'],['plain','1'],['fixture-pin','1']].sort());assert.ok(!/^Remv /mu.test(simulated.stdout));await f.unchanged();t.diagnostic('Early APT_CONFIG excludes host hooks; genuine solver --simulate selected exact names/versions, no Remv; fixture dpkg unchanged');
});

test('real APT cannot fall back after the captured version disappears before dispatch',realOptions,async t=>{
 const f=await privateApt(t,packageRecord('fixture-volatile','1'));
 f.setBeforeMutation(async()=>{
  const lists=join(f.root,'var/lib/apt/lists'),files=(await readdir(lists)).filter(name=>name.includes('_Packages'));assert.equal(files.length,1);const old=files[0],plain=old.replace(/\.(?:lz4|gz|xz|bz2)$/u,'');await rm(join(lists,old));await writeFile(join(lists,plain),packageRecord('fixture-volatile','2','Section: private-index-after-capture\n'));
  for(const name of ['pkgcache.bin','srcpkgcache.bin'])await rm(join(f.root,'var/cache/apt',name),{force:true});
  const prefix=Object.entries({'Dir':f.root,'Dir::State::status':f.statusPath}).flatMap(([key,value])=>['-o',key+'='+value]);const now=await f.processExecutor.run({command:'/usr/bin/apt-cache',args:[...prefix,'policy','fixture-volatile'],env:f.env,timeoutMs:10000,maxOutputBytes:65536,effect:'query',...context()});assert.match(now.stdout,/Candidate: 2/u);
 });
 await assert.rejects(f.provider.installPackages(['fixture-volatile'],context()),errorCode('interrupted'));const calls=f.calls.filter(call=>call.effect==='install');assert.equal(calls.length,1);assert.ok(calls[0].args.includes('fixture-volatile=1'));assert.ok(!calls[0].args.includes('fixture-volatile=2'));const pending=f.journal.writes[0];if(pending.state!=='idle')assert.deepEqual(pending.exactTargets,[{name:'fixture-volatile',version:'1'}]);assert.equal(f.provider.status.mutation.state,'interrupted');await f.unchanged();
});

test('real APT no-remove refuses an install requiring removal of an existing package',realOptions,async t=>{
 const installed=installedRecord('fixture-protected'),f=await privateApt(t,packageRecord('fixture-protected')+packageRecord('fixture-conflict','1','Conflicts: fixture-protected\n'),installed);
 await assert.rejects(f.provider.installPackages(['fixture-conflict'],context()),errorCode('interrupted'));const calls=f.calls.filter(call=>call.effect==='install');assert.equal(calls.length,1);assert.ok(calls[0].args.includes('--no-remove'));assert.equal(f.provider.status.mutation.state,'interrupted');await f.unchanged();
});
