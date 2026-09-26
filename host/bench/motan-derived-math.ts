import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {motanDerivative,motanIntegral,motanNorm2,motanSmooth,motanCombine} from '../src/motan/derived-math.ts';
import {derivedOracle} from '../test/helpers/motan-derived-oracle.ts';
import type {DerivedInput} from '../test/helpers/motan-derived-oracle.ts';
const source=Array.from({length:20000},(_,i)=>Math.sin(i*.07)*20+.25),second=Array.from({length:20000},(_,i)=>Math.cos(i*.05)*30-.5),stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(const kind of ['derivative','integral','norm2','smooth','corexy_x'] as const){const input:DerivedInput={kind,source,second,segment:.001},reference=derivedOracle(input,true),run=()=>kind==='derivative'?motanDerivative(source,.001):kind==='integral'?motanIntegral(source,.001,second):kind==='norm2'?motanNorm2([source,second]):kind==='smooth'?motanSmooth(source,.001):motanCombine(source,second,'corexy_x'),ms=[];for(let i=0;i<9;i++){const start=performance.now(),values=run(),elapsed=performance.now()-start;assert.deepEqual(Array.from(values),reference.values);if(i>=2)ms.push(elapsed);}console.log(JSON.stringify({kind,node:process.version,samples:source.length,nodeMs:stats(ms),historicalPythonMs:stats(reference.ms),maxAbsoluteError:0,referenceMode:"captured CPython; this run does not execute Python"}));}
