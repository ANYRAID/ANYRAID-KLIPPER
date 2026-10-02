import assert from 'node:assert/strict';
import {ObjectExclusionTransform} from '../src/gcode/object-exclusion.ts';
import {objectExclusionReference} from '../test/helpers/object-exclusion-reference.ts';
const {actions,metadata}=objectExclusionReference(),samples:number[]=[];
for(let run=0;run<24;run++){
 let physical=[0,0,0,0];const moves:any[]=[];const t=new ObjectExclusionTransform({position:()=>physical,move(p,s){physical=[...p];moves.push([[...p],s]);}}),begin=performance.now();
 for(const a of actions)switch(a.kind){case 'reset':t.reset();break;case 'exclude':t.exclude(a.name);break;case 'unexclude':t.unexclude(a.name);break;case 'start':t.start(a.name);break;case 'end':t.end();break;case 'position':t.position();break;case 'move':t.move(a.position,a.speed);break;}
 const elapsed=performance.now()-begin;if(run>=5)samples.push(elapsed);assert.equal(moves.length,metadata.admittedMoves);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,actions:actions.length,admittedMoves:metadata.admittedMoves,warmups:5,runs:samples.length,medianMs:samples[9],p95Ms:samples[18],pythonReference:metadata.benchmark,scope:'Transform admission with in-memory actions and output collection; no parser, full motion planner, transport or physical printing'},null,2));
