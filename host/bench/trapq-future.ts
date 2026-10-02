import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const rows=new Float64Array(10000*13);for(let i=0;i<10000;i++)rows.set([1+i*.125,0,.125,0,i*.125,0,0,1,0,0,1,1,0],i*13);
const cut=626.0625,position=625.0625,replacement=new Float64Array([cut,0,0,.125,position,0,0,1,0,0,1,1,8]),elapsed:number[]=[],cpu:number[]=[];
for(let i=0;i<14;i++){
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);s.generate(2);s.flush();
 const used=process.cpuUsage(),start=performance.now();q.replaceFutureRaw(cut,replacement);const ms=performance.now()-start,usage=process.cpuUsage(used);
 const data=q.extract(1,0,2000);assert.equal(data[0],cut);assert.equal(data[1],.125);assert.equal(data[4]+(data[2]+data[3]*data[1]/2)*data[1],position+.0625);
 if(i>=3){elapsed.push(ms);cpu.push((usage.user+usage.system)/1000);}
}
elapsed.sort((a,b)=>a-b);cpu.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,moves:10000,samples:11,elapsed:{medianMs:elapsed[5],p95Ms:elapsed[10]},cpu:{medianMs:cpu[5],p95Ms:cpu[10]},scope:'replace 5000-node future suffix retaining a live solver and prefix; construction, initial generation and destruction excluded; no MCU I/O'}));
assert(elapsed[5]<5,'Future queue rewrite exceeds 5ms desktop median budget');
