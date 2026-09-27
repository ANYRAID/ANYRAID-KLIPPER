import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir,cpus,release,endianness} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {motionGraphReference} from '../bench/motion-graph-reference.ts';
const rounds=Number(process.argv[2]??2000);if(process.argv.length>3||!Number.isInteger(rounds)||rounds<1||rounds>100000||endianness()!=='LE')throw Error('Use rounds 1..100000 on little-endian host');
const directory=mkdtempSync(join(tmpdir(),'subtract-control-')),c=fileURLToPath(new URL('../bench/native/subtract-integrity.c',import.meta.url)),js=fileURLToPath(new URL('subtract-integrity.mjs',import.meta.url)),binary=join(directory,'subtract'),fixture=join(directory,'input.f64'),bad=join(directory,'injected.f64'),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const values=[-0.06914286694832938,...motionGraphReference('weighted4',undefined,{order:4,jerkLimit:true}).positions],bytes=Buffer.alloc(values.length*16);values.forEach((v,i)=>{bytes.writeDoubleLE(v,i*16);bytes.writeDoubleLE(v,i*16+8);});writeFileSync(fixture,bytes);const injected=Buffer.from(bytes);injected.writeDoubleLE(1,0);injected.writeDoubleLE(0,8);writeFileSync(bad,injected);
const cc=process.env.CC??'cc',argv=['-std=c11','-O2','-ffp-contract=off','-fno-fast-math','-Wall','-Wextra','-Werror',c,'-o',binary],built=spawnSync(cc,argv,{encoding:'utf8',timeout:30000});if(built.error||built.status!==0)throw Error('C build failed: '+built.stderr);
const versions=spawnSync(cc,['--version'],{encoding:'utf8',timeout:10000});if(versions.status!==0)throw Error('Compiler version unavailable');
const variants=[{name:'C',program:binary,args:[] as string[]},{name:'Node-default',program:process.execPath,args:[js]},{name:'Node-no-optimizers',program:process.execPath,args:['--no-maglev','--no-turbofan',js]}],runs:unknown[]=[];
const report={directory,rounds,values:values.length,node:process.version,cpu:cpus()[0]?.model,kernel:release(),compiler:versions.stdout.trim(),argv,hashes:{fixture:hash(bytes),c:hash(readFileSync(c)),js:hash(readFileSync(js)),binary:hash(readFileSync(binary)),node:hash(readFileSync(process.execPath))},runs,scope:'Same binary64 operand pairs; C volatile loads versus standalone JS typed arrays. Finite passing runs do not clear prior arithmetic inconsistency or crashes.'};
console.log(JSON.stringify({directory,rounds,values:values.length}));
let failed=false;for(const v of variants){for(const control of [true,false]){
 const input=control?bad:fixture,n=control?1:rounds,start=performance.now(),r=spawnSync(v.program,[...v.args,input,String(n)],{encoding:'utf8',timeout:60000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}),elapsedMs=performance.now()-start;
 const passed=!r.error&&r.signal===null&&(control?r.status===2&&r.stdout.includes('"index":0'):r.status===0&&r.stdout.trim()===`subtract:verified:${n}:${values.length}`)&&hash(readFileSync(fixture))===report.hashes.fixture;
 runs.push({variant:v.name,control,status:r.status,signal:r.signal,error:r.error?.message,elapsedMs,stdout:r.stdout,stderr:r.stderr,passed});writeFileSync(join(directory,'report.json'),JSON.stringify({...report,state:passed?'running':'failed'},null,2)+'\n');console.log(JSON.stringify({variant:v.name,control,passed,elapsedMs}));if(!passed){failed=true;break;}
}if(failed)break;}
writeFileSync(join(directory,'report.json'),JSON.stringify({...report,state:failed?'failed':'completed'},null,2)+'\n');if(failed)process.exitCode=1;
