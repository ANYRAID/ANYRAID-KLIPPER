// GPL-3.0-or-later. Captured original log-manager outputs; no Python or Git.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
interface Stored {input:unknown;result:{values:Record<string,string|null>[];labels:Record<string,{label:string;units:string}>;ms:number[];start:string};}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const metadata=JSON.parse(readFileSync(new URL('../../contracts/motan-manager-reference.json',import.meta.url),'utf8'));
let records:Record<string,Stored>|undefined;
const decode=(text:string)=>{assert.match(text,/^[0-9a-f]{16}$/);return Buffer.from(text,'hex').readDoubleBE();};
export function managerOracle(prefix:string,start:number,names:string[],times:number[],bench=false):{values:Record<string,unknown>[];labels:Record<string,{label:string;units:string}>;ms:number[];start:number}{
 if(!records){
  assert.equal(sha(readFileSync(new URL('./motan-manager-fixture.ts',import.meta.url))),metadata.fixtureSha256);
  const zip=readFileSync(new URL('../../contracts/motan-manager-reference.json.gz',import.meta.url));assert.equal(sha(zip),metadata.gzipSha256);
  const data=gunzipSync(zip,{maxOutputLength:16*1024**2});assert.equal(data.length,metadata.dataBytes);assert.equal(sha(data),metadata.dataSha256);
  records=JSON.parse(data.toString());assert.equal(Object.keys(records!).length,metadata.caseCount);
 }
 const input={capture:['.json.gz','.index.gz'].map(s=>sha(readFileSync(prefix+s))),start,names,times,bench},key=sha(JSON.stringify(input)),row=records![key];assert.ok(row,'Missing original manager reference: '+key);assert.deepEqual(row.input,input);
 return {values:row.result.values.map(v=>Object.fromEntries(Object.entries(v).map(([k,n])=>[k,n===null?null:decode(n)]))),labels:structuredClone(row.result.labels),ms:[...row.result.ms],start:decode(row.result.start)};
}
