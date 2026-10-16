import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import type {NativeReading} from '../../src/moonraker/native-template.ts';

interface Reference {
 schema:number;runtime:string;jinja:string;oracleSourceSha256:string;
 inputSha256:string;rawOutputSha256:string;outputJson:string;
 datasets:{conversions:{inputs:unknown[]};rounds:{inputs:{value:string;precision:number;method:string}[]};nativeCases:{inputs:{source:string;payload:string}[]};integerCases:{inputs:{v:number|boolean;p:number;m:string}[]};floats:{inputs:unknown[]}};
}
interface Results {conversions:unknown[];rounds:string[];nativeCases:NativeReading[][];integerCases:('error'|{kind:string;bits:string})[];floats:string[];}
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export const templateNumericReferenceSha256='1014bdd1a41268f9fee7c98c08196d9b6c73338bfaf1ad48bedd3abded66ce4f';
export function decodeTemplateNumericReference(bytes:Buffer){
 assert.equal(sha(bytes),templateNumericReferenceSha256,'Template numeric reference hash mismatch');
 const reference=JSON.parse(gunzipSync(bytes,{maxOutputLength:16000000}).toString()) as Reference;
 assert.equal(reference.schema,1);assert.equal(reference.runtime,'3.12.13');assert.equal(reference.jinja,'3.1.6');
 assert.equal(reference.oracleSourceSha256,'cc483a676ae0ebdf614c0896ba659a01035f7df05d115dbc50dd59bc05b2e53a');
 assert.equal(sha(JSON.stringify(Object.fromEntries(Object.entries(reference.datasets).map(([k,v])=>[k,v.inputs])))),reference.inputSha256);
 assert.equal(sha(reference.outputJson),reference.rawOutputSha256);
 // Keep the original JSON text until this read: re-stringifying -0.0 would
 // silently lose the signed-zero result in the native template cases.
 const results=JSON.parse(reference.outputJson) as Results;
 const counts={conversions:17,rounds:42744,nativeCases:7,integerCases:5424,floats:1293};
 for(const [key,count] of Object.entries(counts)){const name=key as keyof Results;assert.equal(reference.datasets[name].inputs.length,count);assert.equal(results[name].length,count);}
 return {reference,results};
}
export function templateNumericReference(){return decodeTemplateNumericReference(readFileSync(new URL('../../contracts/template-numeric-reference.json.gz',import.meta.url)));}
