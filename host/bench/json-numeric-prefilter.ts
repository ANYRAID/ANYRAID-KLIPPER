import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parseRequestJson} from '../src/moonraker/json.ts';
import {oldJsonParser} from '../test/helpers/json-prefilter-reference.ts';
const old=await oldJsonParser(),stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(const [name,source] of Object.entries({motion:'{"x":120.125,"y":8.5,"velocity":100}',fractional:JSON.stringify({data:Array.from({length:64},(_,i)=>[i/1000,Math.sin(i+.5),Math.cos(i+.3)])}),largeIntegerString:'{"clock":"9007199254740993","x":1.12345678901234567}',safeBoundary:'{"clock":9007199254740991}'})){
 assert.deepEqual(parseRequestJson(source),old(source));const current:number[]=[],previous:number[]=[];for(let run=0;run<9;run++)for(const mode of run%2?[0,1]:[1,0]){const parse=mode?parseRequestJson:old,start=performance.now();for(let i=0;i<10000;i++)parse(source);const ms=performance.now()-start;if(run>=2)(mode?current:previous).push(ms);}console.log(JSON.stringify({name,operations:10000,current:stats(current),previous:stats(previous)}));
}
