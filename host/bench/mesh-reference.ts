// GPL-3.0-or-later. Original Python/NumPy outputs; never computed from the port.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
export type MeshReferenceKind='analysis'|'path'|'surface'|'report'|'source';
const manifest=JSON.parse(readFileSync(new URL('../contracts/mesh-reference.json',import.meta.url),'utf8'));
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type MeshReferences=Record<MeshReferenceKind,{input:unknown;inputSha256:string;reference:any}>;
let cache:MeshReferences|undefined;
function records(){
 if(!cache){
  const compressed=readFileSync(new URL('../contracts/mesh-reference.json.gz',import.meta.url));
  assert.equal(compressed.length,manifest.compressedBytes);assert.equal(hash(compressed),manifest.compressedSha256);
  const bytes=gunzipSync(compressed,{maxOutputLength:16*1024**2});
  assert.equal(bytes.length,manifest.uncompressedBytes);assert.equal(hash(bytes),manifest.dataSha256);
  const data=JSON.parse(bytes.toString('utf8')) as MeshReferences;
  assert.deepEqual(Object.keys(data),manifest.cases);
  for(const row of Object.values(data))assert.equal(hash(JSON.stringify(row.input)),row.inputSha256);
  cache=data;
 }
 return cache;
}
export function meshReference(kind:MeshReferenceKind,input:unknown):any{
 const record=records()[kind];assert.ok(record,'Unknown mesh reference');
 assert.equal(hash(JSON.stringify(input)),record.inputSha256,'Mesh reference input changed');
 return structuredClone(record.reference);
}
export function capturedMeshInput(kind:MeshReferenceKind):unknown{return structuredClone(records()[kind].input);}
