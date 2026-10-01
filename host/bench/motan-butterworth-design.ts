import {performance} from 'node:perf_hooks';
import {motanButterworth} from '../src/motan/sos-design.ts';
import {motanSOSReference} from '../test/helpers/motan-sos-reference.ts';
const cases=[
 {kind:'lowpass',order:8,cutoff:50},{kind:'highpass',order:8,cutoff:50},
 {kind:'bandpass',order:8,cutoff:[20,100]},
 {kind:'bandpass',order:32,cutoff:[20,100]},
 {kind:'bandpass',order:64,cutoff:[20,100]},
] as const;
const reference = motanSOSReference<number[][]>('design',{cases});
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(let c=0;c<cases.length;c++){
 const item=cases[c],ms:number[]=[];
 for(let run=0;run<9;run++){
  const start=performance.now();
  for(let i=0;i<50;i++)motanButterworth(item.order,item.cutoff,item.kind,1000);
  const elapsed=(performance.now()-start)/50;if(run>=2)ms.push(elapsed);
 }
 console.log(JSON.stringify({...item,node:process.version,nodeMs:stats(ms),capturedScipyMs:stats(reference[c]),batch:50,
  referenceScope:'Fixed independent Linux x64 SciPy capture; historical timing, not a current or target-printer run.'}));
}
