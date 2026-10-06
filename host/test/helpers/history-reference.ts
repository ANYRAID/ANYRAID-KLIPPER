import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
type ReferenceName='history-fields'|'history-metadata'|'history-events'|'history-marker'|'history-fields-benchmark';
interface Capture {name:ReferenceName;contract:string;upstreamSourceSha256:string;helper:string;helperSha256:string;input:string;inputSha256:string;output:string;outputSha256:string;}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const bytes=readFileSync(new URL('../../contracts/moonraker-history-reference-retirement.json',import.meta.url));
assert.equal(sha(bytes),'aba9b160e4c88a953e3b477a4143bf7daf3274b42d7909d64665c627d08fd92b','History reference inventory changed');
const reference=JSON.parse(bytes.toString('utf8')) as {schema:number;upstreamCommit:string;captures:Capture[]};
assert.equal(reference.schema,1);
/** Independent upstream output, never calculated from the implementation under test.
 * Raw JSON preserves -0; changed inputs or provenance require a new capture. */
export function historyReference<T=unknown>(name:ReferenceName,input:string|Buffer):T{
 const capture=reference.captures.find(value=>value.name===name);assert.ok(capture,'Missing history reference');
 const upstream=JSON.parse(readFileSync(new URL('../../../'+capture.contract,import.meta.url),'utf8'));
 assert.equal(upstream.commit,reference.upstreamCommit,'History upstream commit changed');
 assert.equal(sha(upstream.source),capture.upstreamSourceSha256,'History upstream source changed');
 assert.equal(sha(readFileSync(new URL('../../../'+capture.helper,import.meta.url))),capture.helperSha256,'History capture harness changed');
 assert.equal(sha(input),capture.inputSha256,'History reference input changed');
 assert.equal(Buffer.isBuffer(input)?input.toString('utf8'):input,capture.input,'History reference input bytes changed');
 assert.equal(sha(capture.output),capture.outputSha256,'History reference output changed');
 return JSON.parse(capture.output) as T;
}
