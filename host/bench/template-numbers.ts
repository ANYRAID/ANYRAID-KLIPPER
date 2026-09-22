import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {templateFloat,templateRoundFloat} from '../src/moonraker/template-numbers.ts';
import {templateNumberOracle} from '../test/helpers/template-number-oracle.ts';
const child=spawnSync('python3',['-c',templateNumberOracle()+`
import time
results={}
for mode in ['float','unicode','round','ceil','floor']:
 samples=[]
 for run in range(9):
  total=0.;start=time.perf_counter()
  for i in range(100000):
   value=do_float('12.675' if i%2 else '-1.005') if mode=='float' else do_float('١_٢.５') if mode=='unicode' else do_round((i%128-64)/8+.005,2,'common' if mode=='round' else mode)
   total+=value
  if run>=2:samples.append((time.perf_counter()-start)*1000)
 results[mode]=dict(samples=samples,total=total)
print(json.dumps(results))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const reference=JSON.parse(child.stdout),results=[];
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[3],p95Ms:values[6]};};
for(const mode of ['float','unicode','round','ceil','floor']){const samples=[];for(let run=0;run<9;run++){let total=0;const start=performance.now();for(let i=0;i<100000;i++)total+=(mode==='float'?templateFloat(i%2?'12.675':'-1.005'):mode==='unicode'?templateFloat('١_٢.５'):templateRoundFloat((i%128-64)/8+.005,2,mode==='round'?'common':mode)) as number;if(run>=2)samples.push(performance.now()-start);assert.equal(total,reference[mode].total);}results.push({mode,node:summary(samples),python:summary(reference[mode].samples)});}
console.log(JSON.stringify({node:process.version,iterations:100000,warmup:2,samples:7,scope:'Primitive numeric filters including loop/dispatch, with exact aggregate comparison; excludes typed bridge and templates',results},null,2));
