import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir,cpus,release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {motionGraphReference} from '../bench/motion-graph-reference.ts';
if(process.argv.length!==2)throw Error('No arguments expected');
const directory=mkdtempSync(join(tmpdir(),'filter-control-')),source=fileURLToPath(new URL('../bench/native/motion-integrity.c',import.meta.url)),script=fileURLToPath(new URL('filter-integrity.mjs',import.meta.url)),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const reference=motionGraphReference('weighted4',undefined,{order:4,jerkLimit:true}),arrays=[reference.positions,...reference.panels.flatMap(p=>p.curves.map(c=>c.values))],input=Buffer.alloc(12+arrays.reduce((n,a)=>n+a.length*8,0));input.writeUInt32LE(0x4d4f5431);input.writeUInt32LE(reference.positions.length,4);input.writeUInt32LE(arrays[1].length,8);let offset=12;for(const a of arrays)for(const v of a){input.writeDoubleLE(v,offset);offset+=8;}
const full=join(directory,'full.f64'),fixture=join(directory,'filter.f64'),binary=join(directory,'motion-c');writeFileSync(full,input);
const compiler=process.env.CC??'cc',argv=['-std=c11','-O2','-ffp-contract=off','-fno-fast-math','-Wall','-Wextra','-Werror',source,'-lm','-o',binary],build=spawnSync(compiler,argv,{encoding:'utf8',timeout:30000});if(build.error||build.status!==0)throw Error('Independent C build failed: '+build.stderr);
const version=spawnSync(compiler,['--version'],{encoding:'utf8',timeout:10000});if(version.status!==0)throw Error('Compiler unavailable');
const generated=spawnSync(binary,[full,'1',fixture],{encoding:'utf8',timeout:10000});if(generated.status!==0||!generated.stdout.endsWith('motion-c:verified:1\n'))throw Error('C reference export failed: '+generated.stdout+generated.stderr);
const expected=readFileSync(fixture);if(expected.length!==reference.positions.length*16)throw Error('C reference export length mismatch');const bad=join(directory,'bad.f64'),injected=Buffer.from(expected);injected.writeDoubleLE(injected.readDoubleLE(reference.positions.length*8+500*8)+1,reference.positions.length*8+500*8);writeFileSync(bad,injected);
const report={directory,node:process.version,compiler:version.stdout.trim(),argv,cpu:cpus()[0]?.model,kernel:release(),hashes:{source:hash(readFileSync(source)),script:hash(readFileSync(script)),node:hash(readFileSync(process.execPath)),binary:hash(readFileSync(binary)),fullFixture:hash(input),filterFixture:hash(expected)},scope:'Reduced weighted4 only. C exports nominal and weighted arrays after validating complete motion against original reference. JS has no application imports. Reduced-workload success is not full-runtime acceptance.',runs:[] as unknown[]};
console.log(JSON.stringify({directory}));let failed=false;
for(const mode of ['default','jitless'])for(const control of [true,false]){
 const rounds=control?1:mode==='default'?1000:64,args=[...(mode==='jitless'?['--jitless']:[]),script,control?bad:fixture,String(rounds)],start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:60000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}),passed=!r.error&&r.signal===null&&(control?r.status===2&&r.stdout.includes('"index":500'):r.status===0&&r.stdout.trim()===`filter:verified:${rounds}:${reference.positions.length}`)&&hash(readFileSync(fixture))===report.hashes.filterFixture;
 report.runs.push({mode,control,rounds,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr,elapsedMs:performance.now()-start,passed});failed||=!passed;writeFileSync(join(directory,'report.json'),JSON.stringify({...report,state:failed?'failed':'running'},null,2)+'\n');console.log(JSON.stringify({mode,control,passed}));if(!passed)break;
}
const captures=readdirSync(directory).filter(p=>p.startsWith('filter.f64.failure')).map(p=>({file:p,sha256:hash(readFileSync(join(directory,p)))}));writeFileSync(join(directory,'report.json'),JSON.stringify({...report,state:failed?'failed':'completed',captures},null,2)+'\n');if(failed)process.exitCode=1;
