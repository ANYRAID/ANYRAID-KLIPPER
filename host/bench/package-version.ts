import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const legacy=execFileSync('git',['-C',root,'show','ce7002be:scripts/make_version.py'],{encoding:'utf8'});
const bootstrap="import sys; source=sys.argv.pop(1); filename=sys.argv.pop(1); exec(compile(source,filename,'exec'), {'__name__':'__main__','__file__':filename})";
function run(python:boolean){const p=python?spawnSync(process.env.PYTHON??'python3',['-c',bootstrap,legacy,root+'scripts/make_version.py','Test Distro'],{encoding:'utf8',timeout:30000}):spawnSync(process.execPath,[root+'scripts/make_version.mts','Test Distro'],{encoding:'utf8',timeout:30000});if(p.status!==0)throw new Error(p.stderr||String(p.error));return p.stdout;}
assert.equal(run(false),run(true));for(let i=0;i<3;i++){run(false);run(true);}const node:number[]=[],python:number[]=[];
for(let i=0;i<11;i++){let start=performance.now();const a=run(false);node.push(performance.now()-start);start=performance.now();const b=run(true);python.push(performance.now()-start);assert.equal(a,b);}
node.sort((a,b)=>a-b);python.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,outputExact:true,nodeMedianMs:node[5],nodeP95Ms:node[10],pythonMedianMs:python[5],pythonP95Ms:python[10],speedup:python[5]/node[5]},null,2));
// Packaging-only one-shot CLI: report startup cost; it is not a print-path throughput gate.
