import assert from 'node:assert/strict';
import {ScheduledOutputPin} from '../src/outputs/output-pin.ts';
import {OutputPinBoundaryTimeline} from '../src/outputs/output-pin-boundaries.ts';
import {BoundaryOutputRouter} from '../src/outputs/boundary-router.ts';
const signal=new AbortController().signal,samples:number[]=[];
for(let run=0;run<10;run++){
 let writes=0;
 const outputs=await Promise.all(['a','b','c'].map(async name=>{
  const pin=new ScheduledOutputPin({async reset(){},async stop(){},align:t=>t,async setValue(){writes++;}},
   {section:'output_pin '+name,name,pin:'PA2',pwm:true,hardware:true,cycleTime:.1,scale:100,initialValue:0,shutdownValue:0},.1);
  await pin.start(()=>0,signal);return {name,output:new OutputPinBoundaryTimeline(pin)};
 }));
 const router=new BoundaryOutputRouter(outputs),start=performance.now();
 for(let batch=0;batch<100;batch++){
  const markers=Array.from({length:100},(_,i)=>{const index=batch*100+i;return {id:router.register(index%2?75:25,outputs[index%3].name),time:1+index*.2};});
  const horizon=markers.at(-1)!.time+.01;await router.deliver(markers,horizon,signal);router.retireThrough(horizon);
 }
 const elapsed=performance.now()-start;assert.equal(writes,10000);assert.equal(router.status.pending,0);
 if(run>=3)samples.push(elapsed);await router.stop();
}
console.log(JSON.stringify({node:process.version,warmups:3,requestsPerSample:10000,outputs:3,batchSize:100,samplesMs:samples,
 medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Three-output motion marker routing, scaled scheduling and retirement with mock ACK; no transport or step generation'},null,2));
