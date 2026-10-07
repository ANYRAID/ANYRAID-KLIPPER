import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const root=new URL('../../',import.meta.url),digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const receipt=JSON.parse(await readFile(new URL('../contracts/multi-extrusion-clock-first-fault.json',import.meta.url),'utf8'));
for(const [path,sha] of Object.entries(receipt.productionFingerprints))assert.equal(digest(await readFile(new URL(path,root))),sha,'Captured production source must remain unchanged.');
const compressed=await readFile(new URL(receipt.archive.path,root));assert.equal(digest(compressed),receipt.archive.sha256);
const raw=gunzipSync(compressed,{maxOutputLength:8*1024*1024});assert.equal(digest(raw),receipt.archive.rawSha256);
const archive=JSON.parse(raw.toString());assert.equal(archive.entries.length,receipt.archive.entryCount);
for(const entry of archive.entries){const bytes=Buffer.from(entry.base64,'base64');assert.equal(bytes.length,entry.bytes);assert.equal(digest(bytes),entry.sha256);}
const last=receipt.controlled.final,entry=archive.entries.find((row:{path:string})=>row.path==='final-direct-observer/stderr.log');
assert.equal(entry.sha256,last.stderrSha256);assert.equal(last.status,1);assert.equal(last.signal,null);assert.equal(last.error,null);
const rows=Buffer.from(entry.base64,'base64').toString().split('\n').filter(line=>line.startsWith('clockRetirement=')).map(line=>JSON.parse(line.slice(16)));
assert.deepEqual(rows,receipt.controlled.retirements);assert.equal(rows.length,2);
assert.equal(rows[0].state,'failed');assert.equal(rows[0].fault.message,'MCU clock samples expired');
assert.equal(rows[1].state,'stopped');assert.equal(rows[1].fault,undefined);assert(rows[1].time>=rows[0].time);
const capture=rows[0].samples,all=[...capture.warmup,...capture.recent],lastUsable=all.filter(row=>row.release!==null).at(-1);
assert.equal(capture.count,61);assert.equal(capture.warmup.length,8);assert.equal(capture.recent.length,32);
assert.equal(capture.count-all.length,21,'Preserve the observation gap rather than calling this a complete replay.');
assert(capture.recent.every((row:{sample:{sentTime:number};release:unknown})=>row.sample.sentTime!==0&&row.release===null));
assert.equal(rows[0].time-lastUsable.sample.receiveTime,receipt.controlled.lastRetainedUsableToFaultSeconds);
assert.equal(receipt.controlled.originalLeaseSeconds,5*.9839);assert(receipt.controlled.lastRetainedUsableToFaultSeconds>=receipt.controlled.originalLeaseSeconds);
console.log(JSON.stringify({verifiedEntries:archive.entries.length,originalCiFailure:receipt.originalCi.hostRun,controlledFixtureExit:last.status,firstFault:rows[0].fault.message,retained:all.length,total:capture.count,missing:capture.count-all.length,scope:'Integrity and first retirement evidence only. Not complete replay, original CI root cause, production fix, performance or G3.'},null,2));
