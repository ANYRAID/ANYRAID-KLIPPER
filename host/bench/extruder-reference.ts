// Fixed original Python results, captured before script retirement; no Python runtime.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {StatsPlot} from '../src/diagnostics/graphstats.ts';
type Timing={medianMs:number;p95Ms:number};
export const extruderManifest=JSON.parse(readFileSync(new URL('../contracts/extruder-retirement.json',import.meta.url),'utf8')) as {dataSha256:string;compressedSha256:string;uncompressedBytes:number;compressedBytes:number;before:{nodeCompute:Timing;pythonCompute:Timing;nodePngExport:Timing}};
const compressed=readFileSync(new URL('../contracts/extruder-retirement.json.gz',import.meta.url));
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
assert.equal(hash(compressed),extruderManifest.compressedSha256);assert.equal(compressed.length,extruderManifest.compressedBytes);
const bytes=gunzipSync(compressed,{maxOutputLength:8*1024**2});assert.equal(hash(bytes),extruderManifest.dataSha256);assert.equal(bytes.length,extruderManifest.uncompressedBytes);
const reference=JSON.parse(bytes.toString('utf8')) as {plot:StatsPlot;positions:number[];raw:number[];smooth:number[];samples:number[];smoothCases:Record<string,number[]>};
export function extruderReference(){return reference;}
