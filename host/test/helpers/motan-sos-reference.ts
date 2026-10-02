// GPL-3.0-or-later. Fixed independent SciPy and mpmath outputs, never the port.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
type Group = 'sos' | 'scalar' | 'design';
interface Entry {offset:number; compressedBytes:number; bytes:number; sha256:string;}
interface Manifest {
  schema:number;
  data:{bytes:number; sha256:string};
  groups:Record<Group,Record<string,Entry>>;
}
const manifest = JSON.parse(readFileSync(new URL('../../contracts/motan-sos-reference.json',import.meta.url),'utf8')) as Manifest;
const hash = (data:string|Uint8Array) => createHash('sha256').update(data).digest('hex');
let archive:Buffer|undefined;
/** Match the complete request before opening a record. New inputs need a new
 * independent capture; missing/corrupt references never invoke an interpreter. */
export function motanSOSReference<T>(group:Group, request:unknown):T {
  assert.equal(manifest.schema,1);
  const inputSha256 = hash(JSON.stringify(request,(_key,value) => Object.is(value,-0) ? {$sosNegativeZero:true} : value)), entry = manifest.groups[group]?.[inputSha256];
  assert(entry,'Unknown Motan SOS '+group+' reference input; capture an independent reference for changed fixtures');
  if (!archive) {
    const bytes = readFileSync(new URL('../../contracts/motan-sos-reference.bin',import.meta.url));
    assert.equal(bytes.length,manifest.data.bytes); assert.equal(hash(bytes),manifest.data.sha256); archive = bytes;
  }
  assert(Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.compressedBytes) && entry.compressedBytes > 0 && entry.offset + entry.compressedBytes <= archive.length);
  assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 8*1024**2);
  const bytes = gunzipSync(archive.subarray(entry.offset,entry.offset + entry.compressedBytes),{maxOutputLength:8*1024**2});
  assert.equal(bytes.length,entry.bytes); assert.equal(hash(bytes),entry.sha256);
  const row = JSON.parse(bytes.toString('utf8'),(_key,value) => value && typeof value === 'object' && value.$sosNegativeZero === true ? -0 : value) as {inputSha256:string; reference:T};
  assert.equal(row.inputSha256,inputSha256); return row.reference;
}
