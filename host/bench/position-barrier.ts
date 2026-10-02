import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
function run(kind:string,aligned:boolean){using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,1,0,0,100,1000,2,0,.2,0,90,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,kind==='pressure'?'extruder':'x',.01);if(kind==='shaper')s.configureShapers({x:inputShaper('zvd',40,.1)});if(kind==='pressure')s.configurePressureAdvance(.05,.04);if(aligned)s.initializePosition(500000n,123n);for(let i=0;i<=110;i++)s.generate(1+i*.01);return s.flush();}
const results=[];
for(const kind of ['plain','shaper','pressure']){const base=run(kind,false),aligned=run(kind,true);assert.deepEqual(aligned.messages,base.messages);assert.equal(aligned.position,base.position+123n);
 const normalize=(h:BigInt64Array,offset:bigint)=>{const out=[];for(let i=0;i<h.length;i+=6)if(h[i+3]!==0n)out.push([h[i],h[i+1],h[i+2]-offset,h[i+3],h[i+4],h[i+5]]);return out;};assert.deepEqual(normalize(aligned.history,123n),normalize(base.history,0n));
 const timings=[[],[]] as number[][];for(let repeat=0;repeat<14;repeat++)for(const flag of repeat%2?[true,false]:[false,true]){const start=performance.now();run(kind,flag);if(repeat>=3)timings[flag?1:0].push(performance.now()-start);}timings.forEach(v=>v.sort((a,b)=>a-b));results.push({kind,steps:String(base.position),baselineMedianMs:timings[0][5],alignedMedianMs:timings[1][5],baselineP95Ms:timings[0][10],alignedP95Ms:timings[1][10]});}
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,results,payloadsIdentical:true,historyIdenticalAfterPositionOffset:true,scope:'111 rolling native generation calls per fixture, including create/flush/output. Both paths use the current C implementation; no hardware deadline claim.'},null,2));
