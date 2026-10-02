// Development-only differential oracle; never imported by the host runtime.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { trilateration, gaussianSolve } from '../src/math/mathutil.ts';
import type { Vec3 } from '../src/math/mathutil.ts';
if (Number(process.versions.node.split('.')[0])!==26) throw new Error('Benchmark requires Node.js 26');
let seed=0x19260817;
const random=() => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/2**32; };
const cases=Array.from({length:1000},() => {
  const centers: [Vec3,Vec3,Vec3]=[[0,0,0],[100+random()*100,0,0],[random()*30,100+random()*100,0]];
  const point: Vec3=[random()*100,random()*100,-10-random()*300];
  const radii=centers.map(c => c.reduce((s,v,i) => s+(v-point[i])**2,0)) as unknown as Vec3;
  const a=Array.from({length:4},(_,i) => Array.from({length:4},(_,j) => (i===j?10:0)+random()));
  const rhs=Array.from({length:4},() => [random(),random()]);
  return {centers,radii,point,a,rhs};
});
const oracle=String.raw`
import sys,json,types,time,statistics,importlib.util
sys.modules['queuelogger']=types.ModuleType('queuelogger')
spec=importlib.util.spec_from_file_location('mathutil',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with open(sys.argv[2]) as f: cases=json.load(f)
def batch(kind):
    checksum=0.
    for c in cases:
        if kind=='trilateration': r=m.trilateration(c['centers'],c['radii']); checksum+=r[2]
        else: r=m.gaussian_solve(c['a'],c['rhs']); checksum+=r[0][0]
    return checksum
timings={}
for kind in ['trilateration','gaussianSolve']:
    for _ in range(5): batch(kind)
    samples=[]
    for _ in range(21):
        t=time.perf_counter(); batch(kind); samples.append((time.perf_counter()-t)*1000)
    timings[kind]=sorted(samples)
print(json.dumps({'results':[{'point':m.trilateration(c['centers'],c['radii']),'solution':m.gaussian_solve(c['a'],c['rhs'])} for c in cases], 'timings':timings,'python':sys.version}))
`;
const temporary=mkdtempSync(join(os.tmpdir(),'anyraid-math-'));
const input=join(temporary,'cases.json');
writeFileSync(input,JSON.stringify(cases));
let result;
try {
  result=spawnSync('python3',['-c',oracle,fileURLToPath(new URL('../../klippy/mathutil.py',import.meta.url)),input],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000});
} finally { rmSync(temporary,{recursive:true,force:true}); }
if(result.status!==0) throw new Error(result.stderr || String(result.error));
const reference=JSON.parse(result.stdout);
let maxPositionError=0, maxPythonError=0, maxResidual=0;
for (let i=0;i<cases.length;i++) {
  const c=cases[i], p=trilateration(c.centers,c.radii), x=gaussianSolve(c.a,c.rhs)!;
  p.forEach((v,j) => {
    maxPositionError=Math.max(maxPositionError,Math.abs(v-c.point[j]));
    maxPythonError=Math.max(maxPythonError,Math.abs(v-reference.results[i].point[j]));
  });
  x.forEach((row,j) => row.forEach((v,k) => {
    assert.ok(Math.abs(v-reference.results[i].solution[j][k])<1e-12);
    const residual=c.a[j].reduce((s,a,l) => s+a*x[l][k],0)-c.rhs[j][k];
    maxResidual=Math.max(maxResidual,Math.abs(residual));
  }));
}
assert.ok(maxPositionError<1e-9 && maxPythonError<1e-9 && maxResidual<1e-12);
let checksum=0;
const measurements: Record<string,unknown>={};
for(const kind of ['trilateration','gaussianSolve']) {
  const batch=() => { for(const c of cases) checksum+=kind==='trilateration'?trilateration(c.centers,c.radii)[2]:gaussianSolve(c.a,c.rhs)![0][0]; };
  for(let i=0;i<5;i++) batch();
  const times=[];
  for(let i=0;i<21;i++) { const start=performance.now(); batch(); times.push(performance.now()-start); }
  times.sort((a,b) => a-b);
  const baseline=reference.timings[kind];
  measurements[kind]={nodeMedianMs:times[10],nodeP95Ms:times[19],pythonMedianMs:baseline[10],pythonP95Ms:baseline[19],medianSpeedup:baseline[10]/times[10]};
  // This is a local regression gate, not a target-board print-speed claim.
  assert.ok(times[10]<=baseline[10],`${kind} slower than Python baseline`);
}
console.log(JSON.stringify({node:process.version,python:reference.python,cpu:os.cpus()[0].model,platform:`${os.platform()} ${os.arch()}`,cases:cases.length,warmups:5,samples:21,maxPositionError,maxPythonError,maxResidual,measurements,checksum},null,2));
