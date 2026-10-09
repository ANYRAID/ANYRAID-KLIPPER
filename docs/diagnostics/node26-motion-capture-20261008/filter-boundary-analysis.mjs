import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {deserialize} from 'node:v8';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fromSaved,zero,round,add,sub,mul,magnitudeAtLeast,controls} from './anyraid-captured-ieee-core.mjs';
const [directory,output]=process.argv.slice(2),hash=b=>createHash('sha256').update(b).digest('hex');
assert(directory&&output);
const reportBytes=readFileSync(join(directory,'report.json')),report=JSON.parse(reportBytes);
assert.equal(report.filterTrace,'on');assert.equal(report.limit,1);assert.equal(report.workers,1);
assert.equal(report.childDeadlineMs,10000);assert.equal(report.state,'completed');
assert.equal(report.results.length,1);assert.equal(report.results[0].status,0);assert.equal(report.results[0].signal,null);
assert.equal(report.filterTraceFiles.length,16);
assert.equal(report.results[0].progress.trim().split('\n').length,64);
const historicalCompressed=readFileSync(new URL('motion-mismatch-3750822-0.bin.gz',import.meta.url));
assert.equal(hash(historicalCompressed),'3fda69c7012dd1729aa178d7eba01ff8866b94a5d0c5ae305a86207ad056350b');
const historicalRaw=gunzipSync(historicalCompressed);
assert.equal(hash(historicalRaw),'2359afd3d10045963ba3fbc3a5014ebdafdf9d9a7f11750e1bdf2526d1efdf10');
const historical=deserialize(historicalRaw),weight=round(15n,16n*83n**5n),selected=[4398,4399,7855,7856,8661,8662];
const same=(actual,expected,label)=>assert.equal(fromSaved(actual).bits,expected.bits,label);
let terms=0,points=0;const files=[];
for(const file of report.filterTraceFiles){
 // Resolve sealed captures inside the supplied directory, never trust historical
 // absolute paths from the report when replaying an extracted evidence archive.
 const name=file.path.split('/').at(-1);assert(/^motion-filter-trace-\d+-\d+\.bin$/.test(name));
 const bytes=readFileSync(join(directory,name));assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256);
 const trace=deserialize(bytes);assert.equal(trace.schema,1);assert.equal(trace.calls.length,1);
 const call=trace.calls[0];assert.equal(call.inputBefore.length,historical.stages.nominal.length);assert.equal(call.inputAfter.length,call.inputBefore.length);
 call.inputBefore.forEach((sample,index)=>{
  same(sample,fromSaved(historical.stages.nominal[index]),'historical input '+index);
  same(call.inputAfter[index],fromSaved(sample),'input lifetime '+index);
 });
 same(call.weight,weight,'weight');assert.deepEqual(call.points.map(p=>p.index),selected);
 for(const point of call.points){
  assert.equal(point.n,83);assert.equal(point.steps.length,166);let high=zero,low=zero;
  for(const [offset,row] of point.steps.entries()){
   assert.equal(row.index,point.index-83+offset);assert.equal(row.d,row.index-point.index);assert.equal(row.abs,Math.abs(row.d));
   same(row.sample,fromSaved(call.inputBefore[row.index]),'operand read');
   same(row.highBefore,high,'prior high');same(row.lowBefore,low,'prior low');
   const coefficient=round((83n**2n-BigInt(row.d)**2n)**2n);
   const value=mul(fromSaved(row.sample),coefficient),next=add(high,value);
   same(row.value,value,'weighted term');same(row.next,next,'sum transition');
   low=add(low,magnitudeAtLeast(high,value)?add(sub(high,next),value):add(sub(value,next),high));
   high=next;same(row.high,high,'stored high');same(row.low,low,'compensation transition');terms++;
  }
  const sum=add(high,low);same(point.sum,sum,'final sum');same(point.output,mul(sum,weight),'stored output');points++;
 }
 files.push({file:file.path.split('/').at(-1),run:trace.run,sha256:file.sha256,bytes:file.bytes});
}
assert.equal(new Set(files.map(f=>f.run)).size,16);assert.equal(terms,15936);assert.equal(points,96);
const result={schema:1,date:'2026-10-09',node:process.version,childNode:report.version,reportSha256:hash(reportBytes),analyzerSha256:hash(readFileSync(new URL(import.meta.url))),coreSha256:hash(readFileSync(new URL('anyraid-captured-ieee-core.mjs',import.meta.url))),historicalRawSha256:hash(historicalRaw),controls,files,observedLoops:16,observedPoints:points,observedTerms:terms,inputMatchesHistoricalCapture:true,inputBeforeAfterBitEqual:true,allRecordedTransitionsMatchIntegerBinary64Model:true,originalAssertionsPassed:true,originalChildDeadlineMs:report.childDeadlineMs,childElapsedMs:report.results[0].elapsedMs,source:report.filterTraceSources,scope:'One instrumented source child only. The original sixteen loops, references, tolerances and ten-second deadline were retained. Actual single-read operands, compensated transitions and assignment boundaries were recorded at six fixed indices; the instrumented program can change JIT shape and timing. No mismatch occurred, so this does not distinguish or close the historical arithmetic, input-change, storage, runtime/compiler/hardware hypotheses. Not a performance measurement, production acceptance or G3 closure.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({observedLoops:16,points,terms,allTransitionsMatch:true,historicalFailureReproduced:false,scope:result.scope}));
