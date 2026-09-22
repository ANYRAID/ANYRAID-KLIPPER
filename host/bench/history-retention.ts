import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {StepHistory} from '../src/motion/step-history.ts';
const baseline='f4c0220c',file=new URL(`../src/motion/.history-baseline-${process.pid}.ts`,import.meta.url);
try{
 writeFileSync(file,execFileSync('git',['show',`${baseline}:host/src/motion/step-history.ts`]),{flag:'wx'});
 const Before=(await import(file.href) as {StepHistory:typeof StepHistory}).StepHistory;
 const samples:number[][]=[[],[]],rows=20000;
 for(let round=0;round<14;round++)for(const variant of round%2?[1,0]:[0,1]){
  const C=variant?StepHistory:Before,h=new C(0n,0n),start=performance.now();let sum=0n;
  for(let i=1;i<=rows;i++){const t=BigInt(i);h.append({history:new BigInt64Array([t,t,t-1n,1n,1n,0n]),position:t},t);sum+=h.at(t);}
  const elapsed=performance.now()-start;assert.equal(sum,BigInt(rows*(rows+1)/2));if(round>=3)samples[variant].push(elapsed);
 }
 const rolling:number[]=[];
 for(let round=0;round<14;round++){
  const h=new StepHistory(0n,0n,2048),start=performance.now();let sum=0n;
  for(let i=1;i<=100000;i++){const t=BigInt(i);if(i>1500)h.pruneBefore(t-1500n);h.append({history:new BigInt64Array([t,t,t-1n,1n,1n,0n]),position:t},t);sum+=h.at(t);}
  const elapsed=performance.now()-start;assert.equal(sum,5000050000n);assert.equal(h.status.rows,1500);if(round>=3)rolling.push(elapsed);
 }
 for(const s of [...samples,rolling])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
 console.log(JSON.stringify({node:process.version,baseline,samples:11,appendLookupRows:rows,previous:stats(samples[0]),current:stats(samples[1]),rollingRows:100000,retainedRows:1500,rolling:stats(rolling),scope:'integer archive append, exact lookup and rolling prune; no MCU or print throughput'}));
 assert(samples[1][5]<=samples[0][5]*1.25+1,'Archive median regression exceeds 25% plus 1ms');assert(rolling[5]<500,'100k rolling archive operations exceed 500ms desktop budget');
}finally{rmSync(file,{force:true});}
