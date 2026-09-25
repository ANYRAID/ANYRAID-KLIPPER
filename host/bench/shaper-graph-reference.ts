// Hash-verified original Python data, captured before diagnostic retirement.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {ShaperSimulationOptions} from '../src/diagnostics/graph-shaper.ts';
export interface ReferenceResult {result:{freqs:number[];response:number[][];times:number[];step:number[][]};timings:number[];}
type Timing={medianMs:number;p95Ms:number};
export const shaperGraphManifest=JSON.parse(readFileSync(new URL('../contracts/shaper-graph-retirement.json',import.meta.url),'utf8')) as {dataSha256:string;compressedSha256:string;uncompressedBytes:number;compressedBytes:number;before:{nodeCompute:Timing};exportBefore:{results:({format:string}&Timing)[]}};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),compressed=readFileSync(new URL('../contracts/shaper-graph-retirement.json.gz',import.meta.url));
assert.equal(hash(compressed),shaperGraphManifest.compressedSha256);assert.equal(compressed.length,shaperGraphManifest.compressedBytes);
const bytes=gunzipSync(compressed,{maxOutputLength:16*1024**2});assert.equal(hash(bytes),shaperGraphManifest.dataSha256);assert.equal(bytes.length,shaperGraphManifest.uncompressedBytes);
const data=JSON.parse(bytes.toString('utf8')) as {cases:ShaperSimulationOptions[];references:ReferenceResult[]};
assert.equal(data.cases.length,data.references.length);
const key=(c:ShaperSimulationOptions)=>JSON.stringify(Object.entries(c).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)));
const references=new Map(data.cases.map((c,i)=>[key(c),data.references[i]]));
export function shaperGraphReference(cases:ShaperSimulationOptions[]):ReferenceResult[]{return cases.map(c=>{const result=references.get(key(c));assert.ok(result,'No original Python reference for this simulation case');return result;});}
