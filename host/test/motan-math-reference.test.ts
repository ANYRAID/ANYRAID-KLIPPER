import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {derivedOracle} from './helpers/motan-derived-oracle.ts';
test('captured math references reject changed inputs and return independent values',()=>{
 const input={kind:'integral' as const,source:[1e16,1,-1e16,3,.5],segment:.001};
 const a=derivedOracle(input),before=[...a.values];a.values[0]=123;assert.deepEqual(derivedOracle(input).values,before);
 assert.throws(()=>derivedOracle({...input,source:[1e16,1,-1e16,3,.6]}),/Unknown Motan/);assert.throws(()=>derivedOracle(input,true),/Unknown Motan/);
});
test('every archived CPython case has an intact bounded record and nonoverlapping archive range',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../contracts/motan-math-reference.json',import.meta.url),'utf8')),data=readFileSync(new URL('../contracts/motan-math-reference.bin',import.meta.url));
 const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');assert.equal(hash(data),manifest.data.sha256);let offset=0,count=0;
 for(const group of ['derived','scalar','csv'])for(const [key,entry] of Object.entries(manifest.groups[group]) as [string,{offset:number;compressedBytes:number;bytes:number;sha256:string}][]){
  assert.equal(entry.offset,offset);const bytes=gunzipSync(data.subarray(offset,offset+entry.compressedBytes),{maxOutputLength:4*1024**2});assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);const row=JSON.parse(bytes.toString('utf8'));assert.equal(row.inputSha256,key);assert((typeof row.reference.values==='string'||Array.isArray(row.reference.values)));assert(Array.isArray(row.reference.ms));offset+=entry.compressedBytes;count++;
 }
 assert.equal(offset,data.length);assert.equal(count,223);
});
