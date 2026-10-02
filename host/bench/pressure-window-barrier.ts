import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MotionCoordinator,type MotionBatch} from '../src/motion/coordinator.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
const rows:number[]=[0,0,1,0,0,0,0,0,0,0,0,0,0];let time=1,x=0;
for(let i=0;i<1000;i++){const sign=i%4<2?1:-1;rows.push(time,.0001,.0008,.0001,x,0,0,1,sign>0?1:0,0,0,sign*10,sign*100000);x+=sign*.009;time=((time+.0001)+.0008)+.0001;}
const path=new Float64Array(rows);
async function run(reserved:boolean){
 using q=new TrapQueue();q.appendRaw(path);using e=q.createStepper(settings,'extruder',.01);e.configurePressureAdvance(.05,.04);
 const batches:Readonly<MotionBatch>[]=[];
 const owner=new MotionCoordinator([{id:'e',queue:q,stepper:e}],{async commit(b){batches.push(b);},async stop(){}});
 const until=time+.1+.001,sourceUntil=until+.1+.001;
 if(reserved){const result=await owner.drain(time,new Map([[q,[x,0,0] as const]]),.25,undefined,.1);assert.equal(result.sourceUntil,sourceUntil);assert.equal(result.generatedUntil,until);}
 else{q.appendRaw(new Float64Array([time,0,sourceUntil-time,0,x,0,0,0,0,0,0,0,0]));await owner.advanceBounded(until,0,until,.25);}
 owner.reconfigurePressureWindows(until,[{stepper:'e',advance:.1,smoothTime:.2}]);
 q.appendRaw(new Float64Array([sourceUntil,.125,.25,.125,x,0,0,1,1,0,0,8,64,sourceUntil+.5,0,.3,0,x+3,0,0,0,0,0,0,0,0]));
 await owner.advanceBounded(sourceUntil+.65,0,sourceUntil+.65,.25);
 assert.equal(batches.at(-1)!.outputs[0]!.position,300n);return batches;
}
assert.deepEqual(await run(true),await run(false));
const reserved:number[]=[],manual:number[]=[];
for(let i=0;i<14;i++){for(const useReserved of i%2?[true,false]:[false,true]){const start=performance.now();await run(useReserved);if(i>=3)(useReserved?reserved:manual).push(performance.now()-start);}}
reserved.sort((a,b)=>a-b);manual.sort((a,b)=>a-b);
assert(reserved[5]!<=manual[5]!*1.25+2);assert(reserved[10]!<=manual[10]!*1.5+2);
console.log(JSON.stringify({node:process.version,moves:1000,batchesPacketsHistoryExact:true,reservedMedianMs:reserved[5],reservedP95Ms:reserved[10],manualMedianMs:manual[5],manualP95Ms:manual[10],includesSerialTransport:false},null,2));
