// Independent C arithmetic control for an unresolved host integrity investigation.
// No printer connection, Python execution, runtime replacement or tolerance change.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {motionGraphReference} from '../bench/motion-graph-reference.ts';
const args=process.argv.slice(2),rounds=args.length===0?200:Number(args[1]);
if(args.length!==0&&(args.length!==2||args[0]!=='--rounds')||!Number.isSafeInteger(rounds)||rounds<1||rounds>1000)throw new Error('Use --rounds 1..1000');
const directory=mkdtempSync(join(tmpdir(),'motion-native-control-')),source=fileURLToPath(new URL('../bench/native/motion-integrity.c',import.meta.url)),cc=process.env.CC??'cc',hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const reference=motionGraphReference('weighted4',undefined,{order:4,jerkLimit:true}),arrays=[reference.positions,...reference.panels.flatMap(panel=>panel.curves.map(curve=>curve.values))],values=arrays.reduce((sum,array)=>sum+array.length,0),bytes=Buffer.alloc(12+values*8);
bytes.writeUInt32LE(0x4d4f5431,0);bytes.writeUInt32LE(reference.positions.length,4);bytes.writeUInt32LE(arrays[1].length,8);let offset=12;for(const array of arrays)for(const value of array){bytes.writeDoubleLE(value,offset);offset+=8;}
const fixture=join(directory,'fixture.f64'),fixtureHash=hash(bytes);writeFileSync(fixture,bytes);
const injected=Buffer.from(bytes),injectedPath=join(directory,'injected.f64');injected.writeDoubleLE(1,12+reference.positions.length*8);writeFileSync(injectedPath,injected);
const compiler=spawnSync(cc,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:65536});if(compiler.status!==0)throw new Error('C compiler unavailable');
const variants:{optimization:string;binary:string;sha256:string;argv:string[];control:unknown}[]=[],runs:unknown[]=[];let failed=false;
const execute=(binary:string,input:string,count:number)=>{const start=performance.now(),result=spawnSync(binary,[input,String(count)],{encoding:'utf8',timeout:30000,maxBuffer:65536});return {status:result.status,signal:result.signal,error:result.error?.message,elapsedMs:performance.now()-start,stdout:result.stdout,stderr:result.stderr};};
for(const optimization of ['-O0','-O2']){
 const binary=join(directory,optimization.slice(1)),argv=['-std=c11','-Wall','-Wextra','-Werror',optimization,'-ffp-contract=off','-fno-fast-math',source,'-lm','-o',binary],compiled=spawnSync(cc,argv,{encoding:'utf8',timeout:30000,maxBuffer:65536});if(compiled.status!==0)throw new Error('C control build failed: '+compiled.stderr);
 const control=execute(binary,injectedPath,1);if(control.status!==2||!control.stdout.includes('"curve":0,"index":0'))throw new Error('Injected numerical mismatch was not detected');variants.push({optimization,binary,sha256:hash(readFileSync(binary)),argv,control});
}
console.log(JSON.stringify({directory,rounds,processes:6,fixtureSha256:fixtureHash}));
for(let batch=0;batch<3&&!failed;batch++)for(const index of batch%2?[1,0]:[0,1]){
 const variant=variants[index],unchangedBefore=hash(readFileSync(fixture))===fixtureHash,result=execute(variant.binary,fixture,rounds),unchangedAfter=hash(readFileSync(fixture))===fixtureHash,complete=result.stdout?.trimEnd().endsWith('motion-c:verified:'+rounds);
 failed=!unchangedBefore||!unchangedAfter||result.status!==0||!!result.error||!complete;runs.push({batch,optimization:variant.optimization,unchangedBefore,unchangedAfter,complete,...result});console.log(JSON.stringify({batch,optimization:variant.optimization,status:result.status,signal:result.signal,complete,elapsedMs:result.elapsedMs}));if(failed)break;
}
const report={description:'C control computes fourth-order jerk-limited nominal positions, weighted4 filtering, spring integration, velocities, accelerations and deviations against fixed original Python arrays. Finite success does not clear earlier failures or certify hardware.',directory,node:process.version,nodeSha256:hash(readFileSync(process.execPath)),sourceSha256:hash(readFileSync(source)),fixtureSha256:fixtureHash,compiler:compiler.stdout.trim(),system:{platform:process.platform,arch:process.arch,kernel:release(),cpu:cpus()[0]?.model},rounds,comparedValuesPerRound:values,variants,runs,failed};
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:join(directory,'report.json'),failed}));if(failed)process.exitCode=1;
