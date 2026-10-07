import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const clockBenchmarkReferenceIdentity={capturedAt:'2026-10-07',sha256:'84d35cc64f4d16b3637159d2cb88bebe56c80101f0f0f1a3ee4a9bcab5d102b0',kind:'Frozen independent numerical reference; Python timings are historical desktop samples'} as const;
interface Capture {name:string;input:string;inputSha256:string;output:string;outputSha256:string;}
interface Reference {version:number;captures:Capture[];source:{path:string;sha256:string};}
export function decodeClockBenchmarkReference(bytes:Uint8Array):Reference{
 assert.equal(sha(bytes),clockBenchmarkReferenceIdentity.sha256,'Clock benchmark reference capsule changed');
 const raw=gunzipSync(bytes,{maxOutputLength:8*1024*1024});
 assert.equal(sha(raw),'e3e8d05e319ae87a66df44024ce65d0d9449a87181d986d4c029b6570fffe520','Clock benchmark reference contents changed');
 const reference=JSON.parse(raw.toString()) as Reference;
 assert.equal(reference.version,1);assert.equal(reference.source.path,'klippy/clocksync.py');assert.equal(reference.source.sha256,'79fdf3556dd6afe14e10963699bf6c73e56eb6cad765e9566a90b408781ee37e');
 assert.deepEqual(reference.captures.map(c=>c.name),['clock-sync-periodic','clock-sync-demand','secondary-sync','clock-calibration']);
 for(const capture of reference.captures){assert.equal(sha(capture.input),capture.inputSha256);assert.equal(sha(capture.output),capture.outputSha256);}
 return reference;
}
/** Every result is the actually executed independent original reference. Unknown
 * or modified workloads fail rather than silently fabricating a new oracle. */
export function clockBenchmarkReference<T>(name:string,input:string):T{
 // A benchmark consumes one profile. Do not keep every captured input/output
 // alive across its hot-loop measurements. Only the requested result escapes.
 const reference=decodeClockBenchmarkReference(readFileSync(new URL('../../contracts/clock-benchmark-python-reference.json.gz',import.meta.url)));
 const capture=reference.captures.find(c=>c.name===name);assert.ok(capture,'Missing independent clock benchmark reference');
 assert.equal(sha(input),capture.inputSha256,'Clock benchmark reference input changed');assert.equal(input,capture.input);
 return JSON.parse(capture.output) as T;
}
