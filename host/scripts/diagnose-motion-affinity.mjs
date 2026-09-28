// Linux-only bounded core-affinity control; never changes production affinity.
// All cores execute the same frozen compiled fixture. Stop each core on its
// first failure, retain that failure, and continue the other independent cores.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,realpathSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {join,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cpus,release} from 'node:os';
const options=new Map();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--fixture','--node','--cpus','--rounds','--report'].includes(key)||value===undefined||options.has(key))throw Error('Expected --fixture --node --cpus --rounds --report');options.set(key,value);}
const fixture=options.get('--fixture'),node=options.get('--node'),report=options.get('--report'),rounds=Number(options.get('--rounds')),ids=(options.get('--cpus')??'').split(',').map(Number);
if(process.platform!=='linux'||![fixture,node,report].every(p=>typeof p==='string'&&isAbsolute(p))||!Number.isSafeInteger(rounds)||rounds<1||rounds>64||!options.get('--cpus')||ids.length>64||new Set(ids).size!==ids.length||ids.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Require Linux, absolute paths, unique CPU ids and 1..64 rounds');
const allowed=/^Cpus_allowed_list:\s*(.*)$/m.exec(readFileSync('/proc/self/status','utf8'))?.[1];
function contains(cpu){return allowed?.split(',').some(part=>{const [a,b=a]=part.split('-').map(Number);return cpu>=a&&cpu<=b;});}
if(ids.some(id=>!contains(id)))throw Error('Requested CPU outside current allowed affinity');
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=p=>sha(readFileSync(p));
const binary=realpathSync(node),taskset='/usr/bin/taskset',root=dirname(fixture),compiled=join(root,'compiled');
function inputs(){const result={fixture:hash(fixture)};function walk(path,prefix){for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const key=prefix+'/'+entry.name,full=join(path,entry.name);if(entry.isDirectory())walk(full,key);else if(entry.isFile())result[key]=hash(full);else throw Error('Non-regular frozen input');}}walk(compiled,'compiled');return result;}
const frozen=inputs(),nodeHash=hash(binary),tasksetHash=hash(taskset),env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
const version=spawnSync(binary,['-p','JSON.stringify(process.versions)'],{env,encoding:'utf8',timeout:10000});if(version.status!==0)throw Error('Runtime version probe failed');
mkdirSync(report,{recursive:false});const wrapper=join(report,'affinity-fixture.mjs');
writeFileSync(wrapper,`import {readFileSync} from 'node:fs';
const actual=/^Cpus_allowed_list:\\s*(.*)$/m.exec(readFileSync('/proc/self/status','utf8'))?.[1];
if(actual!==process.argv[2])throw Error('Affinity verification failed: '+actual);
console.log('affinity:'+actual);
await import(${JSON.stringify(pathToFileURL(fixture).href)});
`);
const metadata={hypothesis:'Check whether failures in the same frozen full motion workload concentrate on a CPU core; bounded successful samples never certify a core or close earlier failures.',fixture,rounds,cpus:ids,allowedAffinity:allowed,system:{cpu:cpus()[0]?.model,kernel:release()},runtime:{binary,sha256:nodeHash,versions:JSON.parse(version.stdout)},taskset:{path:taskset,sha256:tasksetHash},inputs:frozen,wrapperSha256:hash(wrapper),startedAt:new Date().toISOString()};
const results=[],stopped=new Set(),start=performance.now(),output=join(report,'report.json');
function checkpoint(state,active=null){writeFileSync(output+'.tmp',JSON.stringify({...metadata,state,active,elapsedMs:performance.now()-start,results},null,2)+'\n',{flush:true});renameSync(output+'.tmp',output);}
checkpoint('running');console.log(JSON.stringify({report:output,cpus:ids,rounds}));
let changed=false;
for(let round=0;round<rounds&&!changed;round++)for(const cpu of round%2?[...ids].reverse():ids){
 if(stopped.has(cpu))continue;checkpoint('running',{round,cpu});const before=performance.now();
 const r=spawnSync(taskset,['-c',String(cpu),binary,'--no-experimental-strip-types',wrapper,String(cpu)],{cwd:report,env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const verified=!r.error&&r.status===0&&r.signal===null&&r.stdout===`affinity:${cpu}\nmotion:loading\nmotion:loaded\nmotion:verified\n`;
 const captures=[];
 if(!verified){stopped.add(cpu);for(const name of readdirSync(root).filter(n=>n.startsWith('motion-mismatch-'+r.pid+'-')&&/\.bin(?:\.repeat)?$/.test(n))){const raw=readFileSync(join(root,name)),compressed=gzipSync(raw);writeFileSync(join(report,name+'.gz'),compressed,{flag:'wx'});captures.push({file:name+'.gz',rawSHA256:sha(raw),compressedSHA256:sha(compressed)});}}
 changed=JSON.stringify(inputs())!==JSON.stringify(frozen)||hash(binary)!==nodeHash||hash(taskset)!==tasksetHash||hash(wrapper)!==metadata.wrapperSha256;
 results.push({round,cpu,pid:r.pid,status:r.status,signal:r.signal,error:r.error?.message,verified,elapsedMs:performance.now()-before,stdout:r.stdout,stderr:r.stderr,captures,inputsUnchanged:!changed});
 checkpoint(changed?'input-changed':'running');if(!verified)console.log(JSON.stringify({round,cpu,status:r.status,signal:r.signal,captures:captures.length}));if(changed)break;
}
checkpoint(changed?'input-changed':stopped.size?'failed':'completed');
console.log(JSON.stringify({report:output,runs:results.length,failedCpus:[...stopped],inputsUnchanged:!changed}));if(changed||stopped.size)process.exitCode=1;
