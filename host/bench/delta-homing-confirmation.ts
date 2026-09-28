import assert from 'node:assert/strict';
import {confirmHomingPass,type HomingPass} from '../src/homing/linear-command.ts';
import {StepHistory} from '../src/motion/step-history.ts';
const groups=[0,1,2].map(()=>{const history=new StepHistory(0n,0n);history.append({history:new BigInt64Array([1n,20n,0n,20n,1n,0n]),position:20n},20n);return {history,stop:{hitClock:10n,reasons:[1],positions:[{member:0,oid:1,raw:12,position:12n,observedClock:20n}]}};});
const pass:HomingPass={movingSteppers:groups.map((_,member)=>({member,oid:1})),stop:{hitClock:null,groups:groups.map(g=>g.stop),memberOffsets:[0,1,2],reasons:[1,1,1],positions:groups.flatMap((g,member)=>g.stop.positions.map(p=>({...p,member})))},histories:groups.map((g,member)=>({member,oid:1,history:g.history})),triggerClocks:[[10n],[10n],[10n]]};
const names=['stepper_a','stepper_b','stepper_c'],samples:number[]=[];
assert.throws(()=>confirmHomingPass({...pass,stop:{...pass.stop,groups:[]}},names,true),/coverage/);
for(let run=0;run<10;run++){const start=performance.now();for(let n=0;n<10000;n++)confirmHomingPass(pass,names,true);if(run>=3)samples.push(performance.now()-start);}
console.log(JSON.stringify({node:process.version,warmups:3,confirmationsPerSample:10000,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Three independent switch histories, trigger coverage and second-pass movement checks; excludes MCU IO, physical homing and print throughput'},null,2));
