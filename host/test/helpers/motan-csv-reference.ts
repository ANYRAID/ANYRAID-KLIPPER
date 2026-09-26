// GPL-3.0-or-later. Frozen original Python CLI results; no Python execution.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const csvReferenceMetadata=JSON.parse(readFileSync(new URL('../../contracts/motan-csv-reference.json',import.meta.url),'utf8'));
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
export interface CsvReferenceCase {id:string;rounds:number;duration:number;segment:number;columns:string[];numeric:number;capture:Record<string,string>;csv:string;decoded:[string[],string[][]];python:{medianMs:number;p95Ms:number};}
let reference:{cases:CsvReferenceCase[];catalog:string}|undefined;
export function motanCsvReference(){
 if(!reference){
  assert.equal(sha(readFileSync(new URL('./motan-manager-fixture.ts',import.meta.url))),csvReferenceMetadata.fixtureSha256);
  const zip=readFileSync(new URL('../../contracts/motan-csv-reference.json.gz',import.meta.url));assert.equal(sha(zip),csvReferenceMetadata.gzipSha256);
  const data=gunzipSync(zip,{maxOutputLength:20*1024**2});assert.equal(data.length,csvReferenceMetadata.dataBytes);assert.equal(sha(data),csvReferenceMetadata.dataSha256);
  reference=JSON.parse(data.toString());assert.equal(reference!.cases.length,csvReferenceMetadata.caseCount);
 }
 return reference!;
}
export function checkMotanCsvCapture(prefix:string,row:CsvReferenceCase){for(const [suffix,hash] of Object.entries(row.capture))assert.equal(sha(readFileSync(prefix+suffix)),hash);}
/** Strict RFC-style CSV reader for the test oracle: quoted multiline fields,
 * doubled quotes and CRLF records. Malformed records never silently normalize. */
export function csvRows(text:string):string[][]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c===','||c==='\r'||c==='\n'){
   row.push(field);field='';closed=false;
   if(c!==','){if(c==='\r'&&text[++i]!=='\n')throw new Error('Invalid CSV newline');rows.push(row);row=[];}
  }else if(closed)throw new Error('Text after CSV quote');
  else if(c==='"'){if(field)throw new Error('Unexpected CSV quote');quoted=true;}
  else field+=c;
 }
 if(quoted)throw new Error('Unterminated CSV quote');
 if(field||closed||row.length)row.push(field),rows.push(row);
 return rows;
}
export function csvBits(value:string):string{assert.notEqual(value.trim(),'');const n=Number(value);assert.ok(Number.isFinite(n));const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');}
export function decodedMotanCsv(text:string,numeric:number):[string[],string[][]]{const [header,...rows]=csvRows(text);assert.ok(header);return [header,rows.map(row=>{assert.equal(row.length,header.length);return row.map((v,i)=>i<numeric?csvBits(v):v);})];}
