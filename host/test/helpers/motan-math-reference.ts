// GPL-3.0-or-later. Fixed original CPython outputs; never computed from the port.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
type Group='derived'|'scalar'|'csv';
interface Entry {offset:number;compressedBytes:number;bytes:number;sha256:string;}
const manifest=JSON.parse(readFileSync(new URL('../../contracts/motan-math-reference.json',import.meta.url),'utf8')) as {schema:number;data:{bytes:number;sha256:string};groups:Record<Group,Record<string,Entry>>};
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
let archive:Buffer|undefined;
/** Exact input matching makes changed/new fixtures fail closed. Parse only the
 * selected record, rather than retaining all large benchmark arrays per test. */
export function motanMathReference<T>(group:Group,request:unknown):T{
 assert.equal(manifest.schema,1);const inputSha256=hash(JSON.stringify(request)),entry=manifest.groups[group]?.[inputSha256];
 assert(entry,'Unknown Motan '+group+' reference input; obtain an independent reference for changed fixtures');
 if(!archive){const bytes=readFileSync(new URL('../../contracts/motan-math-reference.bin',import.meta.url));assert.equal(bytes.length,manifest.data.bytes);assert.equal(hash(bytes),manifest.data.sha256);archive=bytes;}
 assert(Number.isSafeInteger(entry.offset)&&entry.offset>=0&&Number.isSafeInteger(entry.compressedBytes)&&entry.compressedBytes>0&&entry.offset+entry.compressedBytes<=archive.length);
 assert(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=4*1024**2);
 const bytes=gunzipSync(archive.subarray(entry.offset,entry.offset+entry.compressedBytes),{maxOutputLength:4*1024**2});assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
 const row=JSON.parse(bytes.toString('utf8'),(_key,value)=>value&&typeof value==='object'&&value.$motanNegativeZero===true?-0:value) as {inputSha256:string;reference:T};assert.equal(row.inputSha256,inputSha256);return row.reference;
}
