// GPL-3.0-or-later. Captured original analysis results, without Python or Git.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
interface AnalysisReference {times:number[];data:Record<string,number[]>;labels:Record<string,{label:string;units:string}>;ms:number[];}
interface StoredReference {input:unknown;result:{times:string;data:Record<string,string>;labels:AnalysisReference['labels'];ms:number[]};}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const metadata=JSON.parse(readFileSync(new URL('../../contracts/motan-analysis-reference.json',import.meta.url),'utf8'));
let records:Record<string,StoredReference>|undefined;
const decode=(text:string):number[]=>{const bytes=Buffer.from(text,'base64');assert.equal(bytes.length%8,0);return Array.from({length:bytes.length/8},(_,i)=>bytes.readDoubleBE(i*8));};
export function analysisOracle(prefix:string,names:string[],segment:number,duration:number,bench=false):AnalysisReference{
 if(!records){
  assert.equal(sha(readFileSync(new URL('./motan-manager-fixture.ts',import.meta.url))),metadata.fixtureSha256);
  const zip=readFileSync(new URL('../../contracts/motan-analysis-reference.json.gz',import.meta.url));assert.equal(sha(zip),metadata.gzipSha256);
  const data=gunzipSync(zip,{maxOutputLength:64*1024**2});assert.equal(data.length,metadata.dataBytes);assert.equal(sha(data),metadata.dataSha256);
  records=JSON.parse(data.toString());assert.equal(Object.keys(records!).length,metadata.caseCount);
 }
 const input={capture:['.json.gz','.index.gz'].map(s=>sha(readFileSync(prefix+s))),names,segment,duration,bench},key=sha(JSON.stringify(input)),row=records![key];
 assert.ok(row,'Missing original analysis reference: '+key);assert.deepEqual(row.input,input);
 return {times:decode(row.result.times),data:Object.fromEntries(Object.entries(row.result.data).map(([k,v])=>[k,decode(v)])),labels:structuredClone(row.result.labels),ms:[...row.result.ms]};
}
export const analysisNames=['derivative(trapq(toolhead,x))','integral(accelerometer(a,x),trapq(toolhead,velocity),0.015)','norm2(derivative(trapq(toolhead,x)),trapq(toolhead,y))','smooth(trapq(toolhead,x),0.05)','kin(stepper_x)','kin(stepper_y)','corexy(x,stepq(stepper_x),kin(stepper_y))','deviation(corexy(x,stepq(stepper_x),kin(stepper_y)),trapq(toolhead,x))'];
