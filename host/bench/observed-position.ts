import assert from 'node:assert/strict';
import {StepHistory} from '../src/motion/step-history.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
import {observedStepperPosition} from '../src/motion/observed-position.ts';
const origin=1n<<54n,history=new StepHistory(origin,0n),position=new StepperPosition(40,3200),rows=1000,queries=200000,times:number[]=[];
for(let i=0;i<rows;i++){const first=origin+BigInt(i*100+10);history.append({history:new BigInt64Array([first,first+30n,BigInt(i*4),4n,10n,0n]),position:BigInt((i+1)*4)},origin+BigInt((i+1)*100));}
let checksum=0;
for(let run=0;run<13;run++){
 const start=performance.now();let sum=0;
 for(let i=0;i<queries;i++){const tick=i%(rows*100),actual=observedStepperPosition(history,position,origin+BigInt(tick))!;if(run===0){const pulses=Math.floor(tick/100)*4+Math.max(0,Math.min(4,Math.floor((tick%100-10)/10)+1));assert.equal(actual,position.commandedPosition(BigInt(pulses)));}sum+=actual;}
 const elapsed=performance.now()-start;if(run===0)checksum=sum;else assert.equal(sum,checksum);if(run>=2)times.push(elapsed);
}
times.sort((a,b)=>a-b);assert(times[10]<1000);
console.log(JSON.stringify({node:process.version,rows,queries,samples:times.length,medianMs:times[5],p95Ms:times[10],checksum,scope:'Integer history lookup and coordinate conversion; all observations checked against explicit pulse counts; excludes MCU clock estimator and physical execution'},null,2));
