import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {ConsoleFrames,consoleRequest} from '../src/diagnostics/webhook-console.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/webhook-console-framing.json',import.meta.url),'utf8'));
assert.equal(reference.version,1);
const input=Buffer.from(Array.from({length:10000},(_,i)=>JSON.stringify({id:i,method:'objects/query',params:{objects:{toolhead:['position']}}})).join('\n')+'\n');
assert.equal(input.length,reference.fixture.inputBytes);assert.equal(createHash('sha256').update(input).digest('hex'),reference.fixture.inputSha256);
const samples:number[]=[];let frames:string[]=[];
for(let run=0;run<16;run++){
 const framer=new ConsoleFrames(10);frames=[];let printed='';const at=performance.now();
 for(let offset=0;offset<input.length;offset+=4096)for(const line of framer.push(input.subarray(offset,offset+4096))){const value=consoleRequest(line);if(value!==undefined){printed+=`SEND: ${value}\n`;frames.push(value+'\x03');}}
 if(run>=5)samples.push(performance.now()-at);assert.ok(printed.length>input.length);
}
assert.equal(frames.length,reference.fixture.requests);const wireSha256=createHash('sha256').update(frames.join('')).digest('hex');assert.equal(wireSha256,reference.fixture.wireSha256);
const sorted=[...samples].sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,requests:frames.length,inputBytes:input.length,warmups:5,runs:11,nodeFraming:{medianMs:sorted[5],p95Ms:sorted[10],roundsMs:samples},wireSha256,referenceSource:reference.source,recordedBaseline:reference.recordedMeasurement,scope:'Current Node measurement and frozen Python wire fixture. Baseline timings are recorded, not rerun. Includes framing, JSON validation/compaction and SEND accumulation; excludes socket/terminal backpressure and startup.'},null,2));
