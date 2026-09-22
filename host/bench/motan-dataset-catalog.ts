import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../../scripts/motan/data_export.ts',import.meta.url)),legacy=fileURLToPath(new URL('../../scripts/motan/data_export.py',import.meta.url));
const expected=execFileSync('python3',[legacy,'-l']),samples:{python:number[];node:number[]}={python:[],node:[]};
for(let run=0;run<9;run++)for(const mode of (run%2?['node','python']:['python','node']) as ('node'|'python')[]){
 const start=performance.now(),output=execFileSync(mode==='node'?process.execPath:'python3',[mode==='node'?cli:legacy,'--list-datasets'],{timeout:10000,...mode==='node'?{env:{...process.env,PATH:'/no-external-programs'}}:{}}),elapsed=performance.now()-start;
 assert.deepEqual(output,expected);if(run>=2)samples[mode].push(elapsed);
}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
console.log(JSON.stringify({node:process.version,warmups:2,runs:7,bytes:expected.length,python:stats(samples.python),current:stats(samples.node),scope:'Complete CLI startup and dataset listing, alternating order; exact stdout comparison; Node PATH excludes Python. No log reads, analysis or printer motion.'},null,2));
