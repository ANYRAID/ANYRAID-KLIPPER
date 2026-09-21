import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mcuDumpChunks} from '../src/diagnostics/mcu-dump.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/mcu-dump.json',import.meta.url),'utf8'));
assert.equal(reference.version,1);
const ranges=[{start:0xffffc000,length:16384},{start:2,length:16382},{start:3,length:16381}];
assert.deepEqual(reference.input.ranges,ranges);assert.equal(reference.input.valueFormula,'uint32(address * 2654435761)');assert.equal(reference.recordedMeasurement.results.length,ranges.length);
const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex'),results=[];
for(const [index,range] of ranges.entries()){
 const samples=[];let bytes=Buffer.alloc(0),commands:number[][]=[];
 for(let run=0;run<16;run++){commands=[];const chunks=[],start=performance.now();for await(const chunk of mcuDumpChunks(async(order,address)=>{commands.push([order,address]);return Number((BigInt(address)*2654435761n)&0xffffffffn);},range,new AbortController().signal))chunks.push(chunk);bytes=Buffer.concat(chunks);if(run>=5)samples.push(performance.now()-start);}
 const baseline=reference.recordedMeasurement.results[index];assert.equal(hash(bytes),baseline.python.bytes);assert.equal(hash(JSON.stringify(commands)),baseline.python.commands);assert.equal(commands.length,baseline.requests);assert.equal(bytes.length,range.length);samples.sort((a,b)=>a-b);results.push({range,requests:commands.length,sha256:hash(bytes),commandsSha256:hash(JSON.stringify(commands)),node:{medianMs:samples[5],p95Ms:samples[10]}});
}
console.log(JSON.stringify({node:process.version,warmups:5,runs:11,results,referenceSource:reference.source,recordedBaseline:reference.recordedMeasurement,scope:'Current Node asynchronous chunk measurements checked against frozen original Python request/output digests. Historical Python timings are recorded, not rerun. Includes mock values, request recording and output assembly; excludes actual serial ACKs, file I/O, device memory latency and print timing.'},null,2));
