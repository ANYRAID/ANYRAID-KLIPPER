import assert from 'node:assert/strict';
import {CorsPolicy} from '../src/moonraker/cors-policy.ts';

// Construction is outside request timing. No Python or source-derived oracle.
const cases=[
 {name:'literal',domains:['https://fluidd.example.com'],origin:'https://fluidd.example.com',expected:true},
 {name:'wildcard',domains:['https://*.example.com'],origin:'https://fluidd.example.com',expected:true},
 {name:'trusted-ip',domains:['https://*.example.com'],trusted:['192.0.2.0/24'],origin:'http://192.0.2.5:7125',expected:true},
 {name:'denied',domains:['https://*.example.com'],origin:'https://evil.invalid',expected:false},
 {name:'128-literals-denied',domains:Array.from({length:128},(_,i)=>`https://client-${i}.example.com`),origin:'https://evil.invalid',expected:false},
 {name:'128-wildcards-denied',domains:Array.from({length:128},(_,i)=>`https://*.client-${i}.example.com`),origin:'https://evil.invalid',expected:false},
 {name:'bounded-long-pattern',domains:['https://(a+)+'],origin:'https://'+'a'.repeat(1000)+'b',expected:false},
];
const results=[];
for(const input of cases){
 const policy=new CorsPolicy(input.domains,input.trusted),samplesMs:number[]=[],iterations=input.domains.length===128?10000:100000;
 let correct=0;
 for(let round=0;round<8;round++){
  const start=performance.now();for(let i=0;i<iterations;i++)if(policy.matches(input.origin)===input.expected)correct++;
  if(round>=3)samplesMs.push(performance.now()-start);
 }
 assert.equal(correct,8*iterations);
 const medianMs=[...samplesMs].sort((a,b)=>a-b)[2];
 results.push({name:input.name,patterns:input.domains.length,iterations,originBytes:Buffer.byteLength(input.origin),samplesMs,microsecondsPerRequest:medianMs*1000/iterations});
}
console.log(JSON.stringify({runtime:process.version,scope:'Desktop CORS admission CPU cost; 100000 matches per normal round, 10000 per 128-pattern capacity round; 3 warmups and 5 retained rounds; excludes sockets, authentication and motion; no independent target-board CORS budget is supplied',results},null,2));
