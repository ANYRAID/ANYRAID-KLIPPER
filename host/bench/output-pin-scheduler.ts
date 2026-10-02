import assert from 'node:assert/strict';
import {ScheduledOutputPin} from '../src/outputs/output-pin.ts';
import {OutputPinBoundaryTimeline} from '../src/outputs/output-pin-boundaries.ts';
const signal=new AbortController().signal,samples:number[]=[];
for(let run=0;run<10;run++){
 let writes=0;
 const pin=new ScheduledOutputPin({async reset(){},async stop(){},align:t=>t,
  async setValue(_time,value){assert.ok(value===.25||value===.75);writes++;},
 },{section:'output_pin light',name:'light',pin:'PA2',pwm:true,hardware:true,cycleTime:.1,scale:100,initialValue:0,shutdownValue:0},.1);
 await pin.start(()=>0,signal);const timeline=new OutputPinBoundaryTimeline(pin),start=performance.now();
 for(let batch=0;batch<100;batch++){
  const markers=Array.from({length:100},(_,i)=>({id:timeline.register(i%2?75:25),time:1+(batch*100+i)*.2}));
  const horizon=markers.at(-1)!.time+.01;
  await timeline.deliver(markers,horizon,signal);timeline.retireThrough(horizon);
 }
 const ms=performance.now()-start;assert.equal(writes,10000);assert.equal(timeline.status.pending,0);
 if(run>=3)samples.push(ms);await timeline.stop();
}
console.log(JSON.stringify({node:process.version,warmups:3,requestsPerSample:10000,batchSize:100,samplesMs:samples,
 medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Motion marker registration, scaling, scheduled flushing and clock retirement with mock ACK; excludes transport and step generation'},null,2));
