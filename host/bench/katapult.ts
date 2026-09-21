import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {flashKatapult} from '../src/diagnostics/katapult.ts';
import {katapultReference,katapultSimulator} from './katapult-reference.ts';
const image=Buffer.from(Array.from({length:65533},(_,i)=>i*37&255)),warmup=5,runs=11;
const digest=(frames:Buffer[])=>{const h=createHash('sha256');for(const f of frames)h.update(f);return h.digest('hex');};
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
const results=[];
for(const blockSize of [64,128,256,512]){
 const reference=katapultReference(image,blockSize,warmup+runs),expected=digest(reference.frames.map(f=>Buffer.from(f,'hex'))),samples:number[]=[];
 for(let i=0;i<warmup+runs;i++){const sim=katapultSimulator(blockSize),at=performance.now(),result=await flashKatapult(image,sim.transport,new AbortController().signal);const elapsed=performance.now()-at;assert.equal(result.sha1,reference.sha1);assert.equal(digest(sim.frames),expected);if(i>=warmup)samples.push(elapsed);}
 results.push({blockSize,requests:reference.frames.length,requestSha256:expected,node:stats(samples),python:stats(reference.samples.slice(warmup))});
}
console.log(JSON.stringify({node:process.version,imageBytes:image.length,warmup,runs,scope:'Full CONNECT/write/EOF/readback/COMPLETE algorithm with immediate simulated replies and frame recording. Python reads a temporary firmware file and formats suppressed progress; Node snapshots an input buffer and checks every readback byte. No wire delays, priming, physical flash or print throughput.',results},null,2));
