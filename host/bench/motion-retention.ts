import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
async function run(cleanup:boolean){
 using q=new TrapQueue();using x=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);let position=0n;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x}],{async commit(b){position=b.outputs[0].position;},async stop(){}});let time=0,p=0,accepted=0,observed=0,error:unknown;const start=performance.now();
 try{for(let batch=0;batch<150;batch++){const rows=new Float64Array(13000);for(let i=0;i<1000;i++){rows.set([time,.0001,.0008,.0001,p,0,0,1,0,0,0,1,10000],i*13);time=((time+.0001)+.0008)+.0001;p+=.0009;}q.appendRaw(rows);accepted+=1000;observed=Math.max(0,time-.5);await c.advanceSource(time,0,.25,cleanup?()=>c.historyCutoff({x:BigInt(Math.floor(observed*1e6))}):undefined);}await c.drain(time,new Map([[q,[p,0,0] as const]]),.25,cleanup?()=>c.historyCutoff({x:BigInt(Math.floor(observed*1e6))}):undefined);}catch(e){error=e;}
 const elapsed=performance.now()-start,records=q.extract(100000,0,time+1).length/10;return {accepted,elapsedMs:elapsed,records,position:String(position),error:error instanceof Error?error.message:error===undefined?null:String(error)};
}
const retained=await run(true),unbounded=await run(false);assert.equal(retained.error,null);assert.equal(retained.accepted,150000);assert.equal(retained.position,'13500');assert.ok(retained.records<95000);assert.match(unbounded.error??'',/capacity exceeded/);assert.ok(unbounded.accepted<150000);
console.log(JSON.stringify({node:process.version,retained,unbounded,scope:'150 seconds of simulated print time, 150000 native three-phase segments, memory sink and a sampled clock 0.5 s behind source. Extracted records are capped at 100000 (a lower bound for the old path). Old path intentionally hits capacity; timings are not equal completed workloads and do not prove hardware throughput.'},null,2));
