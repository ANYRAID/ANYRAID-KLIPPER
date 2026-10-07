import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bytes=readFileSync(new URL('../../contracts/database-python-retirement-reference.json',import.meta.url));
assert.equal(sha(bytes),'290c4c1c2e15bfecf3a2df01566217c7e4c85c5dd2a3a81dea0942f7f82a3935','Database reference capsule changed');
const reference=JSON.parse(bytes.toString());
const upstream=JSON.parse(readFileSync(new URL('../../contracts/moonraker-database.json',import.meta.url),'utf8'));
assert.equal(reference.version,1);assert.equal(upstream.commit,reference.upstreamCommit);
assert.equal(sha(upstream.source),reference.upstreamSourceSha256,'Database upstream source changed');
assert.equal(new Set(reference.captures.map((c:{name:string})=>c.name)).size,reference.captures.length);
export function databaseReference<T=unknown>(name:string,input:string):T{
 const capture=reference.captures.find((c:{name:string})=>c.name===name);assert.ok(capture,'Missing original database reference');
 assert.equal(sha(capture.input),capture.inputSha256);assert.equal(sha(capture.output),capture.outputSha256);
 assert.equal(input,capture.input,'Database reference input changed');assert.equal(sha(input),capture.inputSha256);
 return JSON.parse(capture.output) as T;
}
/** Actual original SQLite image, not rebuilt from the implementation's codec. */
export function databaseInteropSnapshot():Buffer{
 const compressed=Buffer.from(reference.sqlite.gzipBase64,'base64');assert.equal(sha(compressed),reference.sqlite.gzipSha256);
 const raw=gunzipSync(compressed,{maxOutputLength:65536});assert.equal(raw.length,reference.sqlite.rawBytes);assert.equal(sha(raw),reference.sqlite.rawSha256);return raw;
}
/** Optional historical comparison. Uncaptured configurations still measure Node,
 * with a null baseline; no Python process or fabricated comparison is created. */
export function databaseBenchmarkReference(name:string,workload:string):{capturedAt:string;filesystemMagic:number;runtime:{version:string;sqlite:string;binarySha256:string};samplesMs:number[];scope:string}|null{
 const capture=reference.benchmarks.find((c:{name:string;workload:string})=>c.name===name&&c.workload===workload);if(!capture)return null;
 assert.equal(sha(capture.workload),capture.workloadSha256);assert.equal(sha(capture.output),capture.outputSha256);
 const samplesMs:unknown=JSON.parse(capture.output);assert.ok(Array.isArray(samplesMs)&&samplesMs.length>=5&&samplesMs.every(v=>Number.isFinite(v)&&v>=0));
 return {capturedAt:capture.capturedAt,filesystemMagic:capture.filesystemMagic,runtime:reference.pythonRuntime,samplesMs,scope:'Historical pinned Python samples; not a current paired comparison or target-board printing budget'};
}
