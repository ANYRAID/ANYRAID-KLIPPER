import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const clockRuntimeReferenceSha256='94fdae4b8aaf433c87c780c2ed31eac4feb173a46247554e4f4b98cb39ce457f';
interface Reference {version:number;capturedAt:string;queryCount:number;inputCount:number;outputCount:number;source:{path:string;sha256:string};input:string;inputSha256:string;output:string;outputSha256:string;}
/** Decode only the independently captured original workload. Bounded expansion
 * and pinned hashes prevent a changed reference from silently redefining truth. */
export function decodeClockRuntimeReference(bytes:Uint8Array):Reference{
 assert.equal(sha(bytes),clockRuntimeReferenceSha256,'Clock runtime reference capsule changed');
 const raw=gunzipSync(bytes,{maxOutputLength:1024*1024});
 assert.equal(sha(raw),'a649e3e1967fe45b5609250ac6c973932cd6034f5ec3c0ae004c77de8eac630a','Clock runtime reference contents changed');
 const reference=JSON.parse(raw.toString()) as Reference;
 assert.equal(reference.version,1);assert.equal(reference.queryCount,5000);assert.equal(reference.inputCount,5009);assert.equal(reference.outputCount,5008);
 assert.equal(reference.source.path,'klippy/clocksync.py');assert.equal(reference.source.sha256,'79fdf3556dd6afe14e10963699bf6c73e56eb6cad765e9566a90b408781ee37e');
 assert.equal(sha(reference.input),reference.inputSha256);assert.equal(sha(reference.output),reference.outputSha256);
 assert.equal(JSON.parse(reference.input).length,reference.inputCount);
 return reference;
}
const reference=decodeClockRuntimeReference(readFileSync(new URL('../../contracts/clock-runtime-python-reference.json.gz',import.meta.url)));
/** Keep the original Python numerical result without a Python process. Changed
 * workloads require their own independent capture; never invent an oracle. */
export function clockRuntimeReference(input:string):[number,number,number][]{
 assert.equal(sha(input),reference.inputSha256,'Clock runtime reference input changed');assert.equal(input,reference.input);
 const output=JSON.parse(reference.output) as [number,number,number][];assert.equal(output.length,reference.outputCount);
 for(const row of output)assert.ok(Array.isArray(row)&&row.length===3&&row.every(Number.isFinite)&&row[0]>0&&Number.isSafeInteger(row[2]));
 return output;
}
