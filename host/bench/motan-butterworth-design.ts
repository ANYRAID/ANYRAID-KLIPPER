import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {motanButterworth} from '../src/motan/sos-design.ts';
import {scipyReferenceEnvironment} from '../test/helpers/motan-sos-oracle.ts';
const cases=[
 {kind:'lowpass',order:8,cutoff:50},{kind:'highpass',order:8,cutoff:50},
 {kind:'bandpass',order:8,cutoff:[20,100]},
 {kind:'bandpass',order:32,cutoff:[20,100]},
 {kind:'bandpass',order:64,cutoff:[20,100]},
] as const;
const script=`import json,sys,time,scipy
from scipy.signal import butter
assert scipy.__version__=='1.17.1'
out=[]
for c in json.load(sys.stdin):
 ms=[]
 for run in range(9):
  start=time.perf_counter()
  for i in range(50): butter(c['order'],c['cutoff'],c['kind'],fs=1000,output='sos')
  elapsed=(time.perf_counter()-start)*1000/50
  if run>=2: ms.append(elapsed)
 out.append(ms)
print(json.dumps(out))`;
const reference:number[][]=JSON.parse(execFileSync(process.env.MOTAN_SCIPY_PYTHON??'python3',['-c',script],{
 input:JSON.stringify(cases),encoding:'utf8',env:scipyReferenceEnvironment(),
}));
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(let c=0;c<cases.length;c++){
 const item=cases[c],ms:number[]=[];
 for(let run=0;run<9;run++){
  const start=performance.now();
  for(let i=0;i<50;i++)motanButterworth(item.order,item.cutoff,item.kind,1000);
  const elapsed=(performance.now()-start)/50;if(run>=2)ms.push(elapsed);
 }
 console.log(JSON.stringify({...item,node:process.version,nodeMs:stats(ms),scipyMs:stats(reference[c]),batch:50}));
}
