import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {decodeTemplateBenchmarkReference,templateBenchmarkSummary,type TemplateBenchmarkKey} from '../bench/template-benchmark-reference.ts';
test('frozen benchmark family preserves all original peers and rejects changed input or corrupt bytes',()=>{
 const bytes=readFileSync(new URL('../contracts/template-benchmark-reference.json.gz',import.meta.url));
 const data=JSON.parse(gunzipSync(bytes).toString()) as {entries:Record<TemplateBenchmarkKey,{inputs:Record<string,unknown>}>};
 assert.equal(Object.keys(data.entries).length,5);
 for(const [name,row] of Object.entries(data.entries)){
  const key=name as TemplateBenchmarkKey,reference=decodeTemplateBenchmarkReference<Record<string,unknown>>(bytes,key,row.inputs);
  assert(Object.keys(reference).length>0);
  assert.throws(()=>decodeTemplateBenchmarkReference(bytes,key,{...row.inputs,warmup:1}),/input changed/);
 }
 const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
 assert.throws(()=>decodeTemplateBenchmarkReference(corrupt,'native-template',{}),/reference hash mismatch/);
 assert.throws(()=>decodeTemplateBenchmarkReference(Buffer.alloc(0),'native-template',{}),/reference hash mismatch/);
});
test('benchmark sample summaries retain execution order and reject incomplete or invalid measurements',()=>{
 const samples=[7,3,1,5,4,6,2],summary=templateBenchmarkSummary(samples);
 assert.equal(summary.medianMs,4);assert.equal(summary.p95Ms,7);assert.deepEqual(samples,[7,3,1,5,4,6,2]);
 for(const invalid of [[],[1,2,3,4,5,6],[1,2,3,4,5,6,NaN],[1,2,3,4,5,6,0]])assert.throws(()=>templateBenchmarkSummary(invalid));
});
