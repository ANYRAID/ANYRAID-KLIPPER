// Fixed original Python results; lossless binary64 arrays, no Python execution.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {MotionProfileOptions} from '../src/diagnostics/graph-motion.ts';
import type {MotionFilter} from '../src/diagnostics/motion-filters.ts';
import {motionReferenceKey} from '../contracts/motion-graph-fixtures.ts';
interface Timing {medianMs:number;p95Ms:number;}
interface Panel {curves:{times:string;values:string}[];axis:string;range?:[number,number];}
interface Entry {key:string;samples:number[];pulses:[string,string];positions:string;panels:Panel[];}
interface Result {filter?:string;order?:number;jerkLimit?:boolean;legacyShaper?:string;node:Timing;}
export const motionManifest=JSON.parse(readFileSync(new URL('../contracts/motion-retirement.json',import.meta.url),'utf8')) as {entries:Entry[];arrays:Record<string,{length:number;compressedBytes:number;compressedSha256:string}>;before:{default:{nodeCompute:Timing;nodePngExport:Timing};filters:{results:Result[]};profile:{results:Result[]};legacy:{results:Result[]}}};
const entries=new Map(motionManifest.entries.map(e=>[e.key,e])),cache=new Map<string,number[]>(),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function array(id:string):number[]{
 const prior=cache.get(id);if(prior)return prior;assert.match(id,/^[a-f0-9]{64}$/);const spec=motionManifest.arrays[id];assert.ok(spec);assert.ok(Number.isInteger(spec.length)&&spec.length>=0&&spec.length<=100000);
 const compressed=readFileSync(new URL('../contracts/motion-retirement/'+id+'.f64.gz',import.meta.url));assert.equal(compressed.length,spec.compressedBytes);assert.equal(hash(compressed),spec.compressedSha256);
 const bytes=gunzipSync(compressed,{maxOutputLength:800000});assert.equal(bytes.length,spec.length*8);assert.equal(hash(bytes),id);const result=Array.from({length:spec.length},(_,i)=>bytes.readDoubleLE(i*8));assert.ok(result.every(Number.isFinite));cache.set(id,result);return result;
}
export function motionGraphReference(filter?:MotionFilter,smoothTime=(2/3)/40,profile:MotionProfileOptions={}){
 const ref=entries.get(motionReferenceKey({filter,smoothTime,profile}));assert.ok(ref,'No original Python reference for this motion configuration');
 return {samples:ref.samples,pulses:[array(ref.pulses[0]),array(ref.pulses[1])] as [number[],number[]],positions:array(ref.positions),panels:ref.panels.map(p=>({...p,curves:p.curves.map(c=>({times:array(c.times),values:array(c.values)}))}))};
}
export function assertMotionTiming(current:Timing,before:Timing,output=false){assert.ok(current.medianMs<=before.medianMs*1.25+(output?10:2),`Median regression ${current.medianMs} vs ${before.medianMs}`);assert.ok(current.p95Ms<=before.p95Ms*1.5+(output?20:5),`P95 regression ${current.p95Ms} vs ${before.p95Ms}`);}
