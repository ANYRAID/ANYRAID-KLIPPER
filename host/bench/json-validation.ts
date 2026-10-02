import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {validateJson} from '../src/moonraker/rpc.ts';
const baseline='dec53846e519966a87114a5a5fd5ec89e68c5fa1',samples=51,repo=fileURLToPath(new URL('../../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'json-validation-baseline-'));
try{
 for(const name of ['rpc.ts','json.ts'])await writeFile(join(directory,name),execFileSync('git',['-C',repo,'show',`${baseline}:host/src/moonraker/${name}`]));
 const previous=(await import(pathToFileURL(join(directory,'rpc.ts')).href)).validateJson as (v:unknown)=>void;
 let deep:unknown=null;for(let i=0;i<64;i++)deep={child:deep};const cycle:any={};cycle.self=cycle;const shared={position:[1,2,3]};const fixtures:unknown[]=[null,false,-0,1e20,NaN,Infinity,undefined,1n,new Date(),new Map(),Object.create({x:1}),cycle,deep,{child:deep},Array(99999).fill(null),Array(100000).fill(null),{left:shared,right:shared}];
 let state=42;const random=()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296;};function generate(depth:number):unknown{if(!depth||random()<.45)return [null,false,random()*1e5,'text',undefined,Infinity][Math.floor(random()*6)];const n=Math.floor(random()*5),children=Array.from({length:n},()=>generate(depth-1));return random()<.5?children:Object.fromEntries(children.map((v,i)=>['key'+i,v]));}for(let i=0;i<2000;i++)fixtures.push(generate(8));
 const accepts=(fn:(v:unknown)=>void,v:unknown)=>{try{fn(v);return true;}catch{return false;}};for(const fixture of fixtures)assert.equal(accepts(validateJson,fixture),accepts(previous,fixture));
 const workloads=[{name:'motion-shaped',iterations:100000,value:{toolhead:{position:[1,2,3],velocity:125.5},time:100.25}},{name:'depth-64',iterations:10000,value:deep},{name:'wide-99999',iterations:100,value:Array(99999).fill(null)},{name:'shared-tree',iterations:10000,value:Array(100).fill(shared)}];const results=[];
 for(const work of workloads){const timings:{before:number[];after:number[]}={before:[],after:[]};for(let run=0;run<samples+3;run++)for(const mode of run%2?['after','before'] as const:['before','after'] as const){const fn:(v:unknown)=>void=mode==='before'?previous:validateJson;const start=performance.now();for(let i=0;i<work.iterations;i++)fn(work.value);if(run>=3)timings[mode].push(performance.now()-start);}const stat=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[25],p95Ms:a[48],maxMs:a[50]};};results.push({name:work.name,iterations:work.iterations,before:stat(timings.before),after:stat(timings.after)});}
 console.log(JSON.stringify({node:process.version,baseline,fixtures:fixtures.length,samples,results,scope:'Same-process alternating original committed validator and new validator; acceptance parity includes deterministic invalid values, shared references and budget boundaries. Validation microbenchmark only; not real motion/printing deadline proof.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
