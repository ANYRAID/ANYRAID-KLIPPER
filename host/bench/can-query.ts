import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {decodeCanDiscovery} from '../src/diagnostics/can-query.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/can-query-report.json',import.meta.url),'utf8'));
assert.equal(reference.version,1);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const frames=Array.from({length:10000},(_,i)=>({id:0x3f1,data:[32,255,255,0,0,(i%4096)>>8,i%256,...i%3?[i%3===1?17:99]:[]]}));
assert.equal(frames.length,reference.fixture.frames);assert.equal(hash(JSON.stringify(frames)),reference.fixture.inputSha256);
const buffers=frames.map(f=>({id:f.id,data:Uint8Array.from(f.data)})),samples:number[]=[];let output='',uniqueDevices=0;
for(let run=0;run<16;run++){const start=performance.now(),found=new Set<string>();output='';for(const f of buffers){const d=decodeCanDiscovery(f);if(d&&!found.has(d.uuid)){found.add(d.uuid);output+=`Found canbus_uuid=${d.uuid}, Application: ${d.application}\n`;}}output+=`Total ${found.size} uuids found\n`;if(run>=5)samples.push(performance.now()-start);uniqueDevices=found.size;}
const reportSha256=hash(output);assert.equal(reportSha256,reference.fixture.reportSha256);assert.equal(Buffer.byteLength(output),reference.fixture.reportBytes);assert.equal(uniqueDevices,reference.fixture.uniqueDevices);
const sorted=[...samples].sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,frames:frames.length,uniqueDevices,warmups:5,runs:11,nodeDecode:{medianMs:sorted[5],p95Ms:sorted[10],roundsMs:samples},reportSha256,referenceSource:reference.source,recordedBaseline:reference.recordedMeasurement,scope:'Current Node decode/deduplication/report measurement and frozen original Python report hash. Python timings are recorded, not rerun; included its mock transport calls, which this Node benchmark excludes. No real CAN, two-second wait, startup or print-throughput measurement.'},null,2));
