import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {LocalUserAuthorization} from '../src/moonraker/local-user-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';

// Pass an exact historical local-user-authorization.ts source file, exported
// with git show. Only ordinary local logins and cached JWT verification are
// compared. No deployment passwords or directory/client/hardware connections.
assert(process.versions.node.startsWith('26.'));
assert(process.argv[2],'Expected baseline source path');
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const baseline=await readFile(process.argv[2]),current=await readFile(new URL('../src/moonraker/local-user-authorization.ts',import.meta.url));
const root=await mkdtemp(join(tmpdir(),'ldap-identity-bench-')),owners:LocalUserAuthorization[]=[],databases:DatabaseStore[]=[];
const input={username:'synthetic-local-user',password:'synthetic-local-password',source:'moonraker'},options={issuer:'http://printer.test',now:()=>10000};
const cachedIterations=100000,loginIterations=2,warmups=2,samples=7;
// Fixed before measurement: compare ordinary auth work with 10% proportional
// allowance plus 2 ms batch scheduling noise. These are desktop-only budgets.
const budget={ratio:1.1,batchAllowanceMs:2};
const runs={cached:{baseline:[] as number[],current:[] as number[]},login:{baseline:[] as number[],current:[] as number[]}};
const summarize=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samplesMs:values,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
try{
 const filename=join(root,'baseline.ts');await writeFile(filename,baseline);await symlink(fileURLToPath(new URL('../src/moonraker/rpc.ts',import.meta.url)),join(root,'rpc.ts'));
 const previous=(await import(pathToFileURL(filename).href)).LocalUserAuthorization as typeof LocalUserAuthorization;
 const tokens:string[]=[];
 for(const [index,Owner]of [previous,LocalUserAuthorization].entries()){
  const database=await DatabaseStore.open({path:join(root,index+'.sqlite')});databases.push(database);const owner=await Owner.open(database,options);owners.push(owner);
  tokens.push((await owner.login(input,new AbortController().signal,true)).token);
 }
 for(let round=0;round<warmups+samples;round++)for(const index of [0,1,1,0]){
  const owner=owners[index],name=index?'current':'baseline';let checksum=0;
  const begin=performance.now();for(let iteration=0;iteration<cachedIterations;iteration++)checksum+=owner.decode(tokens[index]).username.length;
  const cached=performance.now()-begin;assert.equal(checksum,cachedIterations*input.username.length);
  const loginBegin=performance.now();for(let iteration=0;iteration<loginIterations;iteration++){const result=await owner.login(input,new AbortController().signal);assert.equal(result.source,'moonraker');assert.equal(owner.decode(result.token).username,input.username);}
  const login=performance.now()-loginBegin;if(round>=warmups){runs.cached[name].push(cached);runs.login[name].push(login);}
 }
 const timings=Object.fromEntries(Object.entries(runs).map(([name,groups])=>{const baseline=summarize(groups.baseline),current=summarize(groups.current);return [name,{baseline,current,medianRatio:current.medianMs/baseline.medianMs,budgetPassed:current.medianMs<=baseline.medianMs*budget.ratio+budget.batchAllowanceMs}];}));
 console.log(JSON.stringify({schema:1,node:process.version,source:{baselineSha256:hash(baseline),currentSha256:hash(current)},inputSha256:hash(JSON.stringify(input)),warmups,samples,order:'ABBA; 14 samples per group',iterations:{cached:cachedIterations,login:loginIterations},budget,timings,scope:'Real private SQLite identity owners and local PBKDF2 logins; cached signed-token checks. No LDAP wire/TLS, official clients, motion, printing or target-board performance claim.'}));
}finally{for(const owner of owners)await owner.close();for(const database of databases)await database.close();await rm(root,{recursive:true,force:true});}
