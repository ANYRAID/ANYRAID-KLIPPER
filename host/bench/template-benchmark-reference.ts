import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export const templateBenchmarkReferenceSha256='80dafe21e1baed64206db4ae98a1542868fc2f15da497af19fff802bac2305a0';
export type TemplateBenchmarkKey='native-template'|'native-template-round'|'template-candidate'|'template-numbers'|'native-sensor-messages';
interface Entry {inputs:unknown;inputSha256:string;rawOutputSha256:string;outputJson:string;}
interface Captured {schema:number;runtime:string;jinja:string;entries:Record<TemplateBenchmarkKey,Entry>;}
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export function decodeTemplateBenchmarkReference<T>(bytes:Buffer,key:TemplateBenchmarkKey,inputs:unknown):T{
 assert.equal(sha(bytes),templateBenchmarkReferenceSha256,'Template benchmark reference hash mismatch');
 const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:1048576}).toString()) as Captured;
 assert.equal(data.schema,1);assert.equal(data.runtime,'3.12.13');assert.equal(data.jinja,'3.1.6');
 const row=data.entries[key];assert(row,'Missing frozen template benchmark');
 assert.deepEqual(inputs,row.inputs,'Frozen template benchmark input changed');
 assert.equal(sha(JSON.stringify(row.inputs)),row.inputSha256);assert.equal(sha(row.outputJson),row.rawOutputSha256);
 // Preserve Python JSON numeric spelling until reading, including -0.0.
 return JSON.parse(row.outputJson) as T;
}
export function templateBenchmarkReference<T>(key:TemplateBenchmarkKey,inputs:unknown):T{return decodeTemplateBenchmarkReference<T>(readFileSync(new URL('../contracts/template-benchmark-reference.json.gz',import.meta.url)),key,inputs);}
export const templateBenchmarkComparison='Frozen original Python/Jinja peer; no Python process and no same-run speedup claim';
export function templateBenchmarkSummary(values:number[]){
 assert.equal(values.length,7);assert(values.every(value=>Number.isFinite(value)&&value>0));
 const sorted=[...values].sort((a,b)=>a-b);return {samplesMs:values,medianMs:sorted[3],p95Ms:sorted[6]};
}
// Fixed before native measurements; the original synchronous template gate uses
// the same 1.5 ratio. JS evaluation incompatibilities remain separate failures.
export const nativeTemplateMedianBudget=1.5;
