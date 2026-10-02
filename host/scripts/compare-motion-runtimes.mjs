// Bounded runtime control: both executables run the exact same frozen JS file.
// A passing local sample never clears prior numerical or process failures.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,mkdirSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {cpus,release} from 'node:os';
const args=new Map();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--fixture','--first','--second','--pairs','--report','--execution'].includes(key)||value===undefined||args.has(key))throw Error('Expected --fixture, --first, --second, --pairs, --report and optional --execution source|compiled');args.set(key,value);}
const execution=args.get('--execution')??'compiled';
const fixture=args.get('--fixture'),report=args.get('--report'),pairs=Number(args.get('--pairs')??32),paths=[args.get('--first'),args.get('--second')];
if(!['source','compiled'].includes(execution)||![fixture,report,...paths].every(p=>typeof p==='string'&&isAbsolute(p))||!Number.isSafeInteger(pairs)||pairs<1||pairs>64)throw Error('Absolute paths and 1..64 pairs required');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
const compiled=join(dirname(fixture),execution);if(!statSync(fixture).isFile()||!statSync(compiled).isDirectory())throw Error('Use a frozen motion diagnostic fixture with its dependency directory');
const inputs={fixture:hash(fixture)};
function collect(root,prefix='',target=inputs){for(const entry of readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix+entry.name,path=join(root,entry.name);if(entry.isDirectory())collect(path,relative+'/',target);else if(entry.isFile())target[execution+'/'+relative]=hash(path);else throw Error('Unexpected non-regular diagnostic input');}}
collect(compiled);
const runtimes=paths.map(path=>{const binary=realpathSync(path),v=spawnSync(binary,['-p','JSON.stringify(process.versions)'],{encoding:'utf8',env,timeout:10000,maxBuffer:65536});if(v.status!==0)throw Error('Runtime cannot report versions');return {binary,sha256:hash(binary),versions:JSON.parse(v.stdout)};});
mkdirSync(report,{recursive:false});const output=join(report,'report.json'),startedAt=new Date().toISOString(),start=performance.now(),results=[];
const metadata={hypothesis:'Compare runtime versions with identical frozen code and reference bytes on the same machine; source and compiled controls are separate bounded samples.',execution,parent:{binary:realpathSync(process.execPath),sha256:hash(realpathSync(process.execPath)),versions:process.versions},system:{cpu:cpus()[0]?.model,kernel:release(),platform:process.platform,arch:process.arch},fixture:resolve(fixture),inputs,runtimes,pairs,startedAt};
function checkpoint(state,active=null){const tmp=output+'.tmp';writeFileSync(tmp,JSON.stringify({...metadata,state,active,elapsedMs:performance.now()-start,results},null,2),{flush:true,mode:0o600});renameSync(tmp,output);}
checkpoint('running');console.log(JSON.stringify({report:output,pairs,runtimes:runtimes.map(r=>r.versions.node)}));
let failed=false;
for(let pair=0;pair<pairs&&!failed;pair++)for(const runtime of pair%2?[1,0]:[0,1]){
 checkpoint('running',{pair,runtime});const before=performance.now(),r=spawnSync(runtimes[runtime].binary,[execution==='compiled'?'--no-experimental-strip-types':'--experimental-strip-types',fixture],{cwd:report,env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const verified=r.status===0&&r.signal===null&&r.stdout==='motion:loading\nmotion:loaded\nmotion:verified\n';
 results.push({pair,runtime,pid:r.pid,status:r.status,signal:r.signal,error:r.error?.message,verified,elapsedMs:performance.now()-before,stdout:r.stdout,stderr:r.stderr});failed=!verified;checkpoint(failed?'failed':'running');
 if(failed){console.log(JSON.stringify(results.at(-1)));break;}
}
// Detect mutation of any frozen input, including transitive compiled modules.
const current={fixture:hash(fixture)};collect(compiled,'',current);const unchanged=JSON.stringify(inputs)===JSON.stringify(current)&&runtimes.every(r=>hash(r.binary)===r.sha256);
if(!unchanged){failed=true;results.push({error:'Frozen input hashes changed',verified:false});}
checkpoint(failed?'failed':'completed');console.log(JSON.stringify({report:output,runs:results.length,verified:results.filter(r=>r.verified).length,inputsUnchanged:unchanged}));if(failed)process.exitCode=1;
