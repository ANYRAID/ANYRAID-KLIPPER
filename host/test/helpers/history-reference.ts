import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
type ReferenceName='history-fields'|'history-metadata'|'history-events'|'history-marker'|'history-fields-benchmark'|'history-api'|'history-repository'|'history-tracker'|'history-rounding'|'history-auxiliary-totals'|'history-api-benchmark'|'history-repository-benchmark'|'history-tracker-benchmark';
type BenchmarkName='history-api-benchmark'|'history-repository-benchmark'|'history-tracker-benchmark';
interface Capture {name:ReferenceName;contract:string;upstreamSourceSha256:string;helper?:string;helperSha256?:string;program?:string;programSha256?:string;input:string;inputSha256:string;output:string;outputSha256:string;workload?:string;workloadSha256?:string;capturedAt?:string;runtime?:string;}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const bytes=readFileSync(new URL('../../contracts/moonraker-history-reference-retirement.json',import.meta.url));
assert.equal(sha(bytes),'b66a887e208ead4686778f240880fee1b40f5a5119d8423031f1e3f513052959','History reference inventory changed');
const reference=JSON.parse(bytes.toString('utf8')) as {schema:number;upstreamCommit:string;captures:Capture[]};
assert.equal(reference.schema,1);
assert.equal(new Set(reference.captures.map(c=>c.name)).size,reference.captures.length,'Duplicate history reference');
function validated(name:ReferenceName):Capture{
 const capture=reference.captures.find(value=>value.name===name);assert.ok(capture,'Missing history reference');
 const upstream=JSON.parse(readFileSync(new URL('../../../'+capture.contract,import.meta.url),'utf8'));
 assert.equal(upstream.commit,reference.upstreamCommit,'History upstream commit changed');
 assert.equal(sha(upstream.source),capture.upstreamSourceSha256,'History upstream source changed');
 if(capture.helper!==undefined)assert.equal(sha(readFileSync(new URL('../../../'+capture.helper,import.meta.url))),capture.helperSha256,'History capture harness changed');
 if(capture.program!==undefined)assert.equal(sha(capture.program),capture.programSha256,'History capture program changed');
 assert.equal(sha(capture.input),capture.inputSha256,'Stored history input changed');
 assert.equal(sha(capture.output),capture.outputSha256,'History reference output changed');
 return capture;
}
/** Independent upstream output, never calculated from the implementation under test.
 * Raw JSON preserves -0; changed inputs or provenance require a new capture. */
export function historyReference<T=unknown>(name:ReferenceName,input:string|Buffer):T{
 const capture=validated(name);
 assert.equal(sha(input),capture.inputSha256,'History reference input changed');
 assert.equal(Buffer.isBuffer(input)?input.toString('utf8'):input,capture.input,'History reference input bytes changed');
 return JSON.parse(capture.output) as T;
}
/** Frozen original numeric corpus; callers still check complete input bytes. */
export function historyReferenceInput(name:ReferenceName):string{return validated(name).input;}
/** Recorded CPython timings are historical; the workload guard is separate from
 * the original stdin (which was empty for repository/tracker benchmarks). */
export function historyBenchmarkReference<T=unknown>(name:BenchmarkName,workload:string):{capturedAt:string;runtime:string;result:T}{
 const capture=validated(name);assert.ok(capture.workload);assert.ok(capture.capturedAt);assert.ok(capture.runtime);
 assert.equal(sha(capture.workload),capture.workloadSha256,'Stored benchmark workload changed');
 assert.equal(workload,capture.workload,'History benchmark workload changed');
 return {capturedAt:capture.capturedAt,runtime:capture.runtime,result:JSON.parse(capture.output) as T};
}
