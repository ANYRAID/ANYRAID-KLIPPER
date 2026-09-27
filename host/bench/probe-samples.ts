import assert from 'node:assert/strict';
import {collectProbeSamples} from '../src/homing/probe-samples.ts';
const s=new AbortController().signal,times:number[]=[];
for(let round=0;round<14;round++){
 const start=performance.now();
 for(let i=0;i<10000;i++){
  const result=await collectProbeSamples({samples:3,retractDistance:2,liftSpeed:5,tolerance:.1,retries:0,result:'average'},async()=>({trigger:[50,20,.123456789,0],halt:[50,20,.12,0]}),async()=>{},s);
  assert.equal(result.position[2],.123456789);
 }
 if(round>=3)times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1];assert(p95<1000,'Sampling reduction exceeded 100 us per session');
console.log(JSON.stringify({node:process.version,sessionsPerRound:10000,samplesPerSession:3,medianMs:times[5],p95Ms:p95,scope:'Sampling policy/reduction only; no MCU movement or transport.'}));
