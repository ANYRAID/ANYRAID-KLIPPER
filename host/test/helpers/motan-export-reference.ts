// GPL-3.0-or-later. Frozen original CSV outputs; never execute Python.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const metadata=JSON.parse(readFileSync(new URL('../../contracts/motan-export-reference.json',import.meta.url),'utf8'));
let records:Record<string,{input:unknown;csv:string}>|undefined;
export function legacyMotanCsv(args:string[],snapshot=false):string{
 if(!records){
  assert.equal(sha(readFileSync(new URL('./motan-manager-fixture.ts',import.meta.url))),metadata.fixtureSha256);
  const zip=readFileSync(new URL('../../contracts/motan-export-reference.json.gz',import.meta.url));assert.equal(sha(zip),metadata.gzipSha256);
  const data=gunzipSync(zip,{maxOutputLength:32*1024**2});assert.equal(data.length,metadata.dataBytes);assert.equal(sha(data),metadata.dataSha256);
  records=JSON.parse(data.toString());assert.equal(Object.keys(records!).length,metadata.caseCount);
 }
 const capture=['.json.gz','.index.gz'].map(s=>sha(readFileSync(args[0]+s))),input={args:args.slice(1),snapshot,capture},key=sha(JSON.stringify(input)),record=records![key];
 assert.ok(record,'Missing frozen original CSV reference: '+key);assert.deepEqual(record.input,input);return record.csv;
}
export const motanExportReferenceMetadata=metadata;
