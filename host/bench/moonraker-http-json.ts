// Frozen workloads from the original exact-JSON acceptance. Reference roots
// must contain independently compiled JS; daily benchmarks require no Python.
import {pathToFileURL} from 'node:url';
import {isAbsolute,join} from 'node:path';
import assert from 'node:assert/strict';
const reference=process.argv.find(value=>value.startsWith('--reference-root='))?.slice('--reference-root='.length);
if(reference&&!isAbsolute(reference))throw new TypeError('Reference root must be absolute');
const {HttpResponse}=reference?await import(pathToFileURL(join(reference,'src/moonraker/http-client.js')).href):await import('../src/moonraker/http-client.ts');
const {parseSecretsText}=reference?await import(pathToFileURL(join(reference,'src/moonraker/secrets.js')).href):await import('../src/moonraker/secrets.ts');
interface Workload {name:string;bytes:Buffer;iterations:number;check:(value:any)=>void;}
const fixtures:Workload[]=[
 {name:'ordinary status',bytes:Buffer.from(JSON.stringify({position:[12.125,-30.5,4.2],speed:125.5,ready:true,count:43})),iterations:10000,check:value=>assert.equal(value.count,43)},
 {name:'wide coordinates',bytes:Buffer.from(JSON.stringify({positions:Array.from({length:128},(_,i)=>[i/10,-i/25,i/32])})),iterations:1000,check:value=>assert.equal(value.positions.length,128)},
 {name:'scientific floats',bytes:Buffer.from('{"positions":['+Array(64).fill('1.23456789012345e100').join(',')+']}'),iterations:1000,check:value=>assert.equal(value.positions.length,64)},
 {name:'strings resembling numbers',bytes:Buffer.from(JSON.stringify({data:' 90071992547409930000000 '.repeat(64),count:8})),iterations:1000,check:value=>assert.equal(value.count,8)},
 {name:'512-bit integer',bytes:Buffer.from('{"value":'+(2n**511n+57n)+'}'),iterations:1000,check:value=>assert.equal(value.value,2n**511n+57n)}
];
if(!process.argv.includes('--existing')){
 const literal='打印机🖨'.repeat(1024),text=JSON.stringify({literal,exact:'replace'}).replace('"replace"',(2n**255n+57n).toString()),utf16=Buffer.from(text,'utf16le'),points=Array.from(text,character=>character.codePointAt(0)!);
 for(const little of [true,false]){
  const bytes=Buffer.alloc(points.length*4);for(let i=0;i<points.length;i++)if(little)bytes.writeUInt32LE(points[i],i*4);else bytes.writeUInt32BE(points[i],i*4);
  fixtures.push({name:'UTF-32 '+(little?'LE':'BE'),bytes,iterations:64,check:value=>assert.deepEqual(value,{literal,exact:2n**255n+57n})});
 }
 for(const little of [true,false])fixtures.push({name:'UTF-16 '+(little?'LE':'BE'),bytes:little?utf16:Buffer.from(utf16).swap16(),iterations:64,check:value=>assert.deepEqual(value,{literal,exact:2n**255n+57n})});
 fixtures.push({name:'UTF-8 surrogatepass',bytes:Buffer.from('22eda08022','hex'),iterations:1000,check:value=>assert.equal(value,'\ud800')});
}
const results=[];
for(const row of fixtures){
 const response=new HttpResponse('/fixture','/fixture',200,row.bytes,new Headers(),null),sampleMs=[];
 for(let run=0;run<9;run++){const start=performance.now();let value;for(let i=0;i<row.iterations;i++)value=response.json();row.check(value);if(run>=2)sampleMs.push(performance.now()-start);}
 results.push({name:row.name,bytes:row.bytes.length,iterations:row.iterations,warmups:2,samples:7,sampleMs,medianMs:[...sampleMs].sort((a,b)=>a-b)[3]});
}
const secret=JSON.stringify({value:'synthetic'.repeat(16),coordinates:[1.25,2.5,3.75],count:32}),sampleMs=[];
for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<10000;i++)assert.equal(parseSecretsText(secret).values.count,32);if(run>=2)sampleMs.push(performance.now()-start);}
results.push({name:'existing private JSON',bytes:Buffer.byteLength(secret),iterations:10000,warmups:2,samples:7,sampleMs,medianMs:[...sampleMs].sort((a,b)=>a-b)[3]});
console.log(JSON.stringify({node:process.version,maximumRatio:1.5,results,scope:'Existing fixed HTTP/private JSON workloads retain original relative gate. New encodings report cost only, with no supported old path. Excludes network, printing and target hardware.'},null,2));
