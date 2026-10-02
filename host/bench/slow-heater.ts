import assert from 'node:assert/strict';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const times:number[]=[];let referenceWrites=0,referenceChecksum=0;
for(let run=0;run<12;run++){
 let now=1,tick=()=>{},writes=0,checksum=0,lastWrite:number|undefined;
 const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3,sampleTimeout:36,refreshOutput:true},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},async reset(){},async setPWM(time,power){assert.equal(power,1);if(lastWrite!==undefined)assert(time-lastWrite<3);lastWrite=time;writes++;checksum+=time+power;},async stop(){}},()=>({system:now,print:now}),{},cb=>{tick=cb;return ()=>{};});
 await runtime.start();runtime.sample(1,197);await runtime.setTarget(200);now=1.1;runtime.sample(now,197);
 const start=performance.now();
 for(let i=2;i<=10001;i++){now=i;if(i%30===0)runtime.sample(now,197);tick();await Promise.resolve();await Promise.resolve();}
 const elapsed=performance.now()-start;assert.equal(runtime.status.phase,'active');assert.equal(runtime.status.lastTime,9990);await runtime.shutdown();
 if(run){assert.equal(writes,referenceWrites);assert.equal(checksum,referenceChecksum);}referenceWrites=writes;referenceChecksum=checksum;if(run>=3)times.push(elapsed);
}
times.sort((a,b)=>a-b);console.log(JSON.stringify({runtime:process.version,ticks:10000,samplePeriodSeconds:30,sampleTimeoutSeconds:36,pwmWatchdogSeconds:3,writes:referenceWrites,checksum:referenceChecksum,warmups:3,runs:9,medianMs:times[4],maxMs:times[8],scope:'virtual clock, real thermal controller and output renewal, immediate fake ACK; no hardware or serial IO'},null,2));
