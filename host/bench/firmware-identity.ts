import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {findFirmwareIdentity} from '../src/diagnostics/firmware-identity.ts';
import {firmwareIdentityReference} from './firmware-identity-reference.ts';
const warmup=5,runs=11,compressed=deflateSync(JSON.stringify({app:'Klipper',config:{MCU:'stm32f407'},version:'v-test'}));
const cases=[{name:'dictionary-at-end',image:Buffer.concat([Buffer.alloc(128*1024,0xff),compressed])},{name:'no-dictionary',image:Buffer.alloc(128*1024,0xff)}];
function stats(a:number[]){const s=[...a].sort((x,y)=>x-y);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
const results=[];
for(const item of cases){const reference=firmwareIdentityReference(item.image,warmup+runs),samples:number[]=[];for(let i=0;i<warmup+runs;i++){const at=performance.now(),found=await findFirmwareIdentity(item.image,new AbortController().signal),elapsed=performance.now()-at;assert.deepEqual(found?{mcu:found.mcu,version:found.version}:null,reference.identity);if(i>=warmup)samples.push(elapsed);}results.push({name:item.name,bytes:item.image.length,python:reference.python,node:stats(samples),original:stats(reference.samples.slice(warmup))});}
console.log(JSON.stringify({node:process.version,warmup,runs,scope:'Dictionary discovery only. Python includes reading a cached temporary file and trying zlib at every byte; Node scans an existing buffer using header prefilter and asynchronous inflate/yields. No physical flash or printing.',results},null,2));
