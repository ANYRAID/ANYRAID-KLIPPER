import {templateBenchmarkReference,templateBenchmarkComparison,templateBenchmarkSummary} from './template-benchmark-reference.ts';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {templateFloat,templateRoundFloat} from '../src/moonraker/template-numbers.ts';
const reference=templateBenchmarkReference<Record<string,{samples:number[];total:number}>>('template-numbers',{modes:['float','unicode','round','ceil','floor'],ascii:['12.675','-1.005'],unicode:'١_٢.５',round:{modulo:128,offset:64,scale:8,add:0.005,precision:2},iterations:100000,warmup:2,samples:7}),results=[];
const summary=templateBenchmarkSummary;
// Fixed before evaluating the numeric lookup candidate; same desktop historical
// median ratio used by the native template gates. This is not a board budget.
const medianBudget=1.5;
for(const mode of ['float','unicode','round','ceil','floor']){const samples=[];for(let run=0;run<9;run++){let total=0;const start=performance.now();for(let i=0;i<100000;i++)total+=(mode==='float'?templateFloat(i%2?'12.675':'-1.005'):mode==='unicode'?templateFloat('١_٢.５'):templateRoundFloat((i%128-64)/8+.005,2,mode==='round'?'common':mode)) as number;if(run>=2)samples.push(performance.now()-start);assert.equal(total,reference[mode].total);}results.push({mode,node:summary(samples),frozenPython:summary(reference[mode].samples),medianRatio:summary(samples).medianMs/summary(reference[mode].samples).medianMs});}
console.log(JSON.stringify({node:process.version,comparison:templateBenchmarkComparison,iterations:100000,warmup:2,samples:7,medianBudget,scope:'Primitive numeric filters including loop/dispatch, with exact aggregate comparison; excludes typed bridge and templates',results},null,2));
assert(results.every(result=>result.medianRatio<=medianBudget),'Template numeric median exceeds fixed historical ratio budget');
