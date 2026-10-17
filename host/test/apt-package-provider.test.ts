import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,open,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {AptPackageProvider,parseAptUpgradablePackages,aptPackageName} from '../src/moonraker/apt-package-provider.ts';
import type {AptMutationJournal,AptMutationState,AptProviderConfiguration} from '../src/moonraker/apt-package-provider.ts';
import {AptPackageError,ProcessAptCommandExecutor} from '../src/moonraker/apt-command-executor.ts';
import type {AptCommandExecutor,AptCommandRequest,AptCommandResult,AptOperationContext} from '../src/moonraker/apt-command-executor.ts';

const commands={apt:'/usr/bin/apt',aptGet:'/usr/bin/apt-get',aptCache:'/usr/bin/apt-cache'};
const linuxOnly=process.platform==='linux'?false:'Linux process groups and /proc required';
const aptAvailable=process.platform==='linux'&&(await Promise.allSettled([...Object.values(commands),'/usr/bin/apt-config'].map(path=>access(path,constants.X_OK)))).every(result=>result.status==='fulfilled');
const context=():AptOperationContext=>({signal:AbortSignal.timeout(10000),authorize:()=>{}});
const rejects=(code:string,dispatched?:boolean)=>(error:unknown)=>error instanceof AptPackageError&&error.code===code&&(dispatched===undefined||error.dispatched===dispatched);
const listing='Listing... Done\nfixture-alpha/test 2 amd64 [upgradable from: 1]\nfixture+plus/test 3 all [upgradable from: 2]\n';
class FakeExecutor implements AptCommandExecutor {
 calls:AptCommandRequest[]=[];handler:(request:AptCommandRequest)=>Promise<AptCommandResult>=async request=>({stdout:request.args.includes('--upgradable')?listing:request.args.includes('search')?'fixture-alpha - Alpha\nfixture+plus - Plus\n':request.args.includes('policy')?request.args.slice(request.args.indexOf('policy')+1).map(name=>`${name}:\n  Installed: (none)\n  Candidate: 2\n  Version table:\n     2 500\n        500 fixture Packages\n`).join(''):'',stderr:'',exitCode:0});
 async run(request:AptCommandRequest){this.calls.push(request);return this.handler(request);}
}
function memoryJournal(initial:unknown=null){let value=structuredClone(initial);const writes:AptMutationState[]=[];const journal:AptMutationJournal={async load(){return structuredClone(value);},async save(next){writes.push(structuredClone(next));value=structuredClone(next);}};return {journal,writes,value:()=>structuredClone(value)};}
async function fixture(options:Partial<AptProviderConfiguration>={}){const executor=new FakeExecutor(),j=memoryJournal(),provider=new AptPackageProvider({commands,executor,journal:j.journal,...options});await provider.initialize(context());return {executor,j,provider};}
const interrupted={schema:1,state:'interrupted',id:'01234567-0123-4123-8123-012345678901',operation:'install',packages:['fixture-alpha'],startedAt:1} as const;

test('APT parser keeps the first record and accepts archive records without depending on header count',()=>{
 assert.deepEqual(parseAptUpgradablePackages(listing),['fixture-alpha','fixture+plus']);
 assert.deepEqual(parseAptUpgradablePackages('fixture-alpha/now 2 amd64 [upgradable from: 1]\n'),['fixture-alpha']);
 assert.deepEqual(parseAptUpgradablePackages('\nListing...\n\n'),[]);
 assert.throws(()=>parseAptUpgradablePackages('unexpected output'),rejects('output'));
 assert.throws(()=>parseAptUpgradablePackages('--option/test 2 amd64'),rejects('output'));
});

test('initialize probes trusted command paths; cached status is defensive and never executes',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());assert.equal(f.executor.calls.length,3);assert.deepEqual(f.executor.calls.map(call=>call.command),Object.values(commands));assert.ok(f.executor.calls.every(call=>call.args.at(-1)==='--version'));
 const start=performance.now();for(let at=0;at<5000;at++){const snapshot=f.provider.status;snapshot.packages.push('foreign');assert.equal(f.provider.status.packageCount,0);}t.diagnostic(`Finite 5000 cached reads: ${(performance.now()-start).toFixed(3)} ms; no performance threshold`);
 assert.equal(f.executor.calls.length,3);assert.equal(f.provider.status.initialized,true);
});

test('refresh uses apt-get update then actual apt listing; failures preserve the last successful snapshot',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());assert.deepEqual(await f.provider.refreshPackages(context()),['fixture-alpha','fixture+plus']);const snapshot=f.provider.status;
 assert.deepEqual(f.executor.calls.slice(3).map(call=>call.args),[['update'],['list','--upgradable']]);
 f.executor.handler=async()=>{throw new AptPackageError('failed','private source credential detail',true,100);};
 await assert.rejects(f.provider.refreshPackages(context()),rejects('failed'));assert.deepEqual(f.provider.status.packages,snapshot.packages);assert.equal(f.provider.status.lastRefresh,snapshot.lastRefresh);assert.equal(f.provider.status.cacheStale,true);assert.deepEqual(f.provider.status.lastError,{operation:'refresh',code:'failed'});assert.ok(!JSON.stringify(f.provider.status).includes('credential'));
});

test('resolve escapes regex names while retaining requested order, duplicates and only available packages',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());assert.deepEqual(await f.provider.resolvePackages(['fixture+plus','missing','fixture-alpha','fixture+plus'],context()),['fixture+plus','fixture-alpha','fixture+plus']);
 assert.deepEqual(f.executor.calls.at(-1)!.args,['search','--names-only','^fixture\\+plus$|^missing$|^fixture-alpha$|^fixture\\+plus$']);const count=f.executor.calls.length;assert.deepEqual(await f.provider.resolvePackages([],context()),[]);assert.equal(f.executor.calls.length,count);
});

test('invalid package names, option injection and unsupported retry counts fail before any command',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());const count=f.executor.calls.length;
 for(const name of ['-y','--allow-unauthenticated','pkg;id','pkg\nnext','Pkg','a','pkg:amd64','pkg=1','pkg*','./pkg','pkg/unstable','x'.repeat(193)]){assert.equal(aptPackageName(name),false);await assert.rejects(f.provider.installPackages([name],context()),rejects('invalid'));await assert.rejects(f.provider.resolvePackages([name],context()),rejects('invalid'));}
 await assert.rejects(f.provider.installPackages(Array(257).fill('valid'),context()),rejects('invalid'));
 for(const retries of [0,2,3,-1,NaN])await assert.rejects(f.provider.installPackages(['valid'],context(),{retries}),rejects('unsupported'));
 for(const options of [{timeout:0},{timeout:3601},{timeout:0.0001},{notify:1},{extra:true}])await assert.rejects(f.provider.installPackages(['valid'],context(),options as any),rejects('invalid'));
 assert.equal(f.executor.calls.length,count);
});

test('legal trailing-sign names reach exact-name resolution and remain visible in listings',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());const count=f.executor.calls.length;
 for(const name of ['fixture-alpha-','fixture-alpha+','g++']){assert.equal(aptPackageName(name),true);assert.deepEqual(await f.provider.resolvePackages([name],context()),[]);}
 assert.equal(f.executor.calls.length,count+3);assert.deepEqual(parseAptUpgradablePackages('g++/test 2 amd64 [upgradable from: 1]\n'),['g++']);
});

test('install refreshes, resolves and durably records one mutation; upgrade uses no implicit refresh/retry',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());assert.deepEqual(await f.provider.installPackages(['missing','fixture-alpha'],context(),{timeout:2,retries:1}),['fixture-alpha']);
 const calls=f.executor.calls.slice(3);assert.equal(calls.length,4);assert.deepEqual(calls.map(call=>call.effect),['cache','query','query','install']);assert.equal(calls[3].timeoutMs,2000);assert.deepEqual(calls[3].args.slice(-4),['install','--yes','--no-remove','fixture-alpha=2']);assert.equal(calls[3].env.LC_ALL,'C');assert.equal(calls[3].env.DEBIAN_FRONTEND,'noninteractive');assert.equal(calls[3].env.HOME,'/nonexistent');assert.equal('NODE_OPTIONS' in calls[3].env,false);
 assert.equal(f.j.writes[0].state,'pending');assert.deepEqual(f.j.writes[0].exactTargets,[{name:'fixture-alpha',version:'2'}]);assert.deepEqual(f.j.writes.at(-1),{schema:1,state:'idle'});assert.equal(f.provider.status.cacheStale,true);
 const count=f.executor.calls.length;await f.provider.upgradeSystem(context());assert.equal(f.executor.calls.length,count+1);assert.deepEqual(f.executor.calls.at(-1)!.args.slice(-2),['upgrade','--yes']);assert.equal(f.executor.calls.at(-1)!.timeoutMs,3600000);
});

test('empty resolution never issues install, and missing mutation journal rejects before cache mutation',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());assert.deepEqual(await f.provider.installPackages(['missing'],context()),[]);assert.equal(f.j.writes.length,0);assert.equal(f.executor.calls.some(call=>call.effect==='install'),false);
 const executor=new FakeExecutor(),provider=new AptPackageProvider({commands,executor});t.after(()=>provider.close());await provider.initialize(context());await assert.rejects(provider.upgradeSystem(context()),rejects('unavailable'));await assert.rejects(provider.installPackages(['fixture-alpha'],context()),rejects('unavailable'));assert.equal(executor.calls.length,3);
});

test('trusted privilege capability reapplies fixed environment after wrapper and preserves argv boundaries',async t=>{
 const f=await fixture({privilege:{command:'/usr/bin/sudo',args:['-n','--'],envCommand:'/usr/bin/env'},configurationFile:'/private/early-apt.conf',aptConfiguration:{'Dir::State::status':'/private/status with spaces'}});t.after(()=>f.provider.close());await f.provider.upgradeSystem(context());const call=f.executor.calls.at(-1)!;assert.equal(call.command,'/usr/bin/sudo');assert.deepEqual(call.args.slice(0,4),['-n','--','/usr/bin/env','-i']);assert.ok(call.args.includes('DEBIAN_FRONTEND=noninteractive'));assert.ok(call.args.includes('APT_CONFIG=/private/early-apt.conf'));assert.equal(call.env.APT_CONFIG,'/private/early-apt.conf');const commandAt=call.args.indexOf('/usr/bin/apt-get');assert.deepEqual(call.args.slice(commandAt,commandAt+3),['/usr/bin/apt-get','-o','Dir::State::status=/private/status with spaces']);
 assert.throws(()=>new AptPackageProvider({commands:{...commands,apt:'apt'}}),rejects('invalid'));assert.throws(()=>new AptPackageProvider({commands,configurationFile:'relative.conf'}),rejects('invalid'));
});

test('known non-dispatch failure clears pending intent; pending write failure never executes',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());f.executor.handler=async request=>{if(request.effect==='upgrade')throw new AptPackageError('authorization','denied',false);return {stdout:'',stderr:'',exitCode:0};};await assert.rejects(f.provider.upgradeSystem(context()),rejects('authorization',false));assert.equal(f.provider.status.mutation.state,'idle');assert.equal(f.j.writes[0].state,'pending');assert.equal(f.j.writes[1].state,'idle');
 const executor=new FakeExecutor(),provider=new AptPackageProvider({commands,executor,journal:{async load(){return null;},async save(){throw Error('disk error');}}});t.after(()=>provider.close());await provider.initialize(context());await assert.rejects(provider.upgradeSystem(context()),rejects('journal',false));assert.equal(executor.calls.length,3);assert.equal(provider.status.mutation.state,'interrupted');
});

test('post-dispatch failure stays interrupted across owners; diagnostic queries remain available',async t=>{
 const f=await fixture();t.after(()=>f.provider.close());f.executor.handler=async request=>{if(request.effect==='upgrade')throw new AptPackageError('failed','partial changes possible',true,100);return {stdout:request.args.includes('--upgradable')?listing:'fixture-alpha - Description\n',stderr:'',exitCode:0};};
 await assert.rejects(f.provider.upgradeSystem(context()),rejects('interrupted',true));assert.equal(f.provider.status.mutation.state,'interrupted');const calls=f.executor.calls.length;await assert.rejects(f.provider.upgradeSystem(context()),rejects('interrupted'));assert.equal(f.executor.calls.length,calls);
 assert.deepEqual(await f.provider.getPackages(context()),['fixture-alpha','fixture+plus']);await f.provider.refreshPackages(context());assert.deepEqual(await f.provider.resolvePackages(['fixture-alpha'],context()),['fixture-alpha']);
 const next=new AptPackageProvider({commands,executor:new FakeExecutor(),journal:f.j.journal});t.after(()=>next.close());await next.initialize(context());assert.equal(next.status.mutation.state,'interrupted');await assert.rejects(next.upgradeSystem(context()),rejects('interrupted'));
});

test('pending journal on reopen is persisted interrupted; malformed journal is not ignored',async t=>{
 const j=memoryJournal({...interrupted,state:'pending'}),f=await fixture({journal:j.journal});t.after(()=>f.provider.close());assert.equal(f.provider.status.mutation.state,'interrupted');assert.equal(j.writes[0].state,'interrupted');
 for(const bad of [{schema:2,state:'idle'},{schema:1,state:'pending'}, {...interrupted,packages:['--bad']}]){const executor=new FakeExecutor(),provider=new AptPackageProvider({commands,executor,journal:memoryJournal(bad).journal});t.after(()=>provider.close());await assert.rejects(provider.initialize(context()));assert.equal(provider.status.initialized,false);}
});

test('completion persistence failure remains interrupted instead of falsely reporting success',async t=>{
 let saved:unknown=null;const journal:AptMutationJournal={async load(){return saved;},async save(value){if(value.state==='idle')throw Error('disk full');saved=structuredClone(value);}};const f=await fixture({journal});t.after(()=>f.provider.close());await assert.rejects(f.provider.upgradeSystem(context()),rejects('interrupted',true));assert.equal((saved as AptMutationState).state,'interrupted');assert.equal(f.provider.status.mutation.state,'interrupted');
});

test('authority revoked by successful pending persistence prevents dispatch and clears intent',async t=>{
 let allowed=true;const writes:AptMutationState[]=[];const journal:AptMutationJournal={async load(){return null;},async save(value){writes.push(structuredClone(value));if(value.state==='pending')allowed=false;}};
 const f=await fixture({journal});t.after(()=>f.provider.close());await assert.rejects(f.provider.upgradeSystem({...context(),authorize:()=>{if(!allowed)throw Error('revoked');}}),rejects('authorization',false));assert.equal(f.executor.calls.length,3);assert.deepEqual(writes.map(row=>row.state),['pending','idle']);assert.equal(f.provider.status.mutation.state,'idle');
});

test('cancellation during completion persistence is interrupted rather than accepted as idle',async t=>{
 const abort=new AbortController();let value:unknown=null;const journal:AptMutationJournal={async load(){return value;},async save(next){value=structuredClone(next);if(next.state==='idle')abort.abort();}};
 const f=await fixture({journal});t.after(()=>f.provider.close());await assert.rejects(f.provider.upgradeSystem({...context(),signal:abort.signal}),rejects('interrupted',true));assert.equal(f.provider.status.mutation.state,'interrupted');assert.equal((value as AptMutationState).state,'interrupted');assert.equal(f.executor.calls.filter(call=>call.effect==='upgrade').length,1);
});

test('serialization rejects concurrent cache/mutation requests; close aborts and drains owned work',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);f.executor.handler=async request=>{entered();await barrier;if(request.signal.aborted)throw new AptPackageError('aborted','cancelled',true);return {stdout:'',stderr:'',exitCode:0};};
 const pending=f.provider.upgradeSystem(context()),rejected=assert.rejects(pending,rejects('interrupted'));await ready;await assert.rejects(f.provider.refreshPackages(context()),rejects('busy'));await assert.rejects(f.provider.getPackages(context()),rejects('busy'));const closing=f.provider.close();release();await rejected;await closing;assert.equal(f.provider.status.busy,false);await assert.rejects(f.provider.getPackages(context()),rejects('closed'));
});

function request(script:string,options:Partial<AptCommandRequest>={}):AptCommandRequest{return {command:process.execPath,args:['-e',script],env:{LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive',PATH:'/usr/bin:/bin'},timeoutMs:2000,maxOutputBytes:65536,effect:'query',...context(),...options};}
test('real executor uses argv only, controlled env, UTF-8 output and authorization on both sides',{skip:linuxOnly},async t=>{
 const executor=new ProcessAptCommandExecutor();t.after(()=>executor.close());let admits=0;const result=await executor.run(request("process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env}));process.stderr.write('stderr');",{args:['-e',"process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env}));process.stderr.write('stderr');",'literal;$(never)'],authorize:()=>{admits++;}}));assert.deepEqual(JSON.parse(result.stdout).argv,['literal;$(never)']);assert.equal(JSON.parse(result.stdout).env.LC_ALL,'C');assert.equal(JSON.parse(result.stdout).env.HOME,undefined);assert.equal(result.stderr,'stderr');assert.equal(admits,2);
 await assert.rejects(executor.run(request('',{authorize:()=>{throw Error('no');}})),rejects('authorization',false));await assert.rejects(executor.run(request('',{command:'/missing/apt-get'})),rejects('unavailable',false));
 let after=0;await assert.rejects(executor.run(request('',{authorize:()=>{if(++after===2)throw Error('revoked');}})),rejects('authorization',true));
});

test('real executor drains child/grandchild on abort, timeout, output limit and parent exit',{skip:linuxOnly},async t=>{
 const executor=new ProcessAptCommandExecutor();t.after(()=>executor.close());const abort=new AbortController();let child=0;
 const tree="const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);";
 const running=executor.run(request(tree,{signal:abort.signal,onOutput:(_stream,text)=>{child=Number(text.trim());abort.abort();}}));await assert.rejects(running,rejects('aborted',true));assert.ok(child>0);
 // A killed orphan may remain a zombie briefly. It must have no executable work.
 const stat=await readFile('/proc/'+child+'/stat','utf8').catch(()=>null);if(stat)assert.ok(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]));
 await assert.rejects(executor.run(request('setInterval(()=>{},1000)',{timeoutMs:30})),rejects('timeout',true));
 await assert.rejects(executor.run(request("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",{maxOutputBytes:8})),rejects('output',true));
 await assert.rejects(executor.run(request("process.exit(100)")),rejects('failed',true));
 const result=await executor.run(request("const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write('done');process.exit(0);"));assert.equal(result.stdout,'done');
});

test('real executor close joins its active child and blocks concurrent and later execution',{skip:linuxOnly},async()=>{
 const executor=new ProcessAptCommandExecutor();let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
 const pending=executor.run(request("process.stdout.write('ready');setInterval(()=>{},1000)",{onOutput:()=>entered()})),failure=assert.rejects(pending,rejects('aborted',true));await ready;await assert.rejects(executor.run(request('')),rejects('busy'));await executor.close();await failure;await assert.rejects(executor.run(request('')),rejects('closed'));
 const clean=new ProcessAptCommandExecutor(),abort=new AbortController();abort.abort();await assert.rejects(clean.run(request('',{signal:abort.signal})),rejects('aborted',false));await clean.close();
});

test('real mutation command timeout is durably interrupted; reopened provider never replays it',{skip:linuxOnly},async t=>{
 const root=await mkdtemp(join(tmpdir(),'apt-mutation-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'apt'),journalPath=join(root,'intent.json'),callsPath=join(root,'calls');
 await writeFile(path,`#!${process.execPath}\nimport{appendFileSync}from'node:fs';const args=process.argv.slice(2);if(args.includes('upgrade')){appendFileSync(${JSON.stringify(callsPath)},'upgrade\\n');setInterval(()=>{},1000);}else process.stdout.write('APT fixture');\n`,{mode:0o700});await writeFile(join(root,'package.json'),'{}');
 const journal:AptMutationJournal={async load(){return JSON.parse(await readFile(journalPath,'utf8').catch(()=> 'null'));},async save(value){const file=await open(journalPath,'w',0o600);try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}}};
 const executor=new ProcessAptCommandExecutor(),bounded:AptCommandExecutor={run:req=>executor.run({...req,timeoutMs:requestTimeout(req)})};function requestTimeout(req:AptCommandRequest){return req.effect==='upgrade'?150:req.timeoutMs;}
 const provider=new AptPackageProvider({commands:{apt:path,aptGet:path,aptCache:path},executor:bounded,journal});t.after(()=>provider.close());t.after(()=>executor.close());await provider.initialize(context());await assert.rejects(provider.upgradeSystem(context()),rejects('interrupted',true));assert.equal(JSON.parse(await readFile(journalPath,'utf8')).state,'interrupted');
 const reopened=new AptPackageProvider({commands:{apt:path,aptGet:path,aptCache:path},executor:bounded,journal});t.after(()=>reopened.close());await reopened.initialize(context());await assert.rejects(reopened.upgradeSystem(context()),rejects('interrupted'));assert.equal(await readFile(callsPath,'utf8'),'upgrade\n');
});

test('real APT uses a private synthetic root; refresh/resolve and simulated install/upgrade never alter dpkg status',{timeout:30000,skip:aptAvailable?false:'Linux and executable apt, apt-get, apt-cache and apt-config required'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'apt-private-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const path of ['etc/apt','var/lib/apt/lists/partial','var/lib/dpkg','var/cache/apt/archives/partial','var/log/apt','repo'])await mkdir(join(root,path),{recursive:true});
 const record=(name:string,version:string)=>`Package: ${name}\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.invalid>\nDescription: Synthetic ${name}\nFilename: nonexistent-${name}.deb\nSize: 1\nSHA256: ${'0'.repeat(64)}\n\n`;
 await writeFile(join(root,'repo/Packages'),record('fixture-alpha','2')+record('fixture+plus','3'));await writeFile(join(root,'etc/apt/sources.list'),`deb [trusted=yes] file:${root}/repo ./\n`);
 const statusPath=join(root,'var/lib/dpkg/status'),installed='Package: fixture-alpha\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: Fixture <fixture@example.invalid>\nArchitecture: amd64\nVersion: 1\nDescription: Fixture installed state\n\n';await writeFile(statusPath,installed);
 const aptConfiguration={'Dir':root,'Dir::State':'var/lib/apt','Dir::State::status':statusPath,'Dir::State::lists':'lists','Dir::Cache':'var/cache/apt','Dir::Cache::archives':'archives','Dir::Etc':'etc/apt','Dir::Etc::sourcelist':'sources.list','Dir::Etc::sourceparts':'-','Dir::Etc::main':'/dev/null','Dir::Etc::parts':'-','Dir::Log':'var/log/apt','APT::Architecture':'amd64','Acquire::Languages':'none'};
 const configurationFile=join(root,'early-apt.conf');await writeFile(configurationFile,`Dir "${root}";\nDir::Etc "${root}/etc/apt";\nDir::Etc::main "/dev/null";\nDir::Etc::parts "-";\n`);
 const processExecutor=new ProcessAptCommandExecutor(),seen:AptCommandRequest[]=[];
 const dumped=await processExecutor.run({command:'/usr/bin/apt-config',args:['dump'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C',APT_CONFIG:configurationFile},timeoutMs:10000,maxOutputBytes:65536,effect:'query',...context()});assert.ok(!/^(?:APT::Update|DPkg)::(?:Pre|Post)-Invoke/mu.test(dumped.stdout),'private early config must exclude all host APT hooks');assert.ok(dumped.stdout.includes(root));
 // Install/upgrade requests still run genuine APT's solver, but simulation is
 // forcibly inserted by this trusted test adapter. No sudo or real mutation.
 const simulated:AptCommandExecutor={async run(req){seen.push(req);if(req.effect==='install'||req.effect==='upgrade')req={...req,args:['--simulate',...req.args]};return processExecutor.run(req);}};
 const provider=new AptPackageProvider({commands,configurationFile,aptConfiguration,executor:simulated,journal:memoryJournal().journal});t.after(()=>provider.close());t.after(()=>processExecutor.close());await provider.initialize(context());assert.deepEqual(await provider.refreshPackages(context()),['fixture-alpha']);assert.deepEqual(await provider.resolvePackages(['fixture+plus','missing','fixture-alpha','fixture+plus'],context()),['fixture+plus','fixture-alpha','fixture+plus']);assert.deepEqual(await provider.installPackages(['fixture+plus'],context()),['fixture+plus']);await provider.upgradeSystem(context());assert.equal(await readFile(statusPath,'utf8'),installed);assert.ok(seen.every(req=>req.command.startsWith('/usr/bin/apt')));assert.ok(seen.every(req=>req.args.includes('Dir='+root)));assert.ok(seen.every(req=>req.env.APT_CONFIG===configurationFile));t.diagnostic('APT_CONFIG dump excludes host hooks; real APT queried/refreshed private indexes and ran install/upgrade --simulate only');
});
