import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {katapultFastHash64,usbSerialToCanUuid} from '../src/diagnostics/katapult-bridge.ts';
import {katapultHashReference} from './katapult-hash-reference.ts';
const cases=Array.from({length:10000},(_,i)=>({hex:Buffer.from(Array.from({length:12},(_,j)=>(i*13+j*71+(i>>8))&255)).toString('hex'),seed:'2707567015'})),warmup=5,runs=11,reference=katapultHashReference(cases,warmup+runs),samples:number[]=[];
for(let i=0;i<warmup+runs;i++){const at=performance.now(),hashes=cases.map(c=>katapultFastHash64(Buffer.from(c.hex,'hex'),BigInt(c.seed)).toString(16).padStart(16,'0')),uuids=cases.map(c=>usbSerialToCanUuid(c.hex)),elapsed=performance.now()-at;assert.deepEqual(hashes,reference.hashes);assert.deepEqual(uuids,reference.uuids);if(i>=warmup)samples.push(elapsed);}
function stats(values:number[]){const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.ceil(s.length*.95)-1]};}
console.log(JSON.stringify({node:process.version,python:reference.python,warmup,runs,serials:cases.length,hashAndUuidPerSerial:true,nodeTiming:stats(samples),pythonTiming:stats(reference.samples.slice(warmup)),scope:'10000 12-byte serials, both generic 64-bit hash and 48-bit UUID conversion, including hex parse/format. Python original tail debug output is captured in memory. No sysfs, USB reconnect or print-speed measurement.'},null,2));
