import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const result=spawnSync(process.execPath,['--test','--test-isolation=none','--test-concurrency=1','--test-reporter=tap',fileURLToPath(new URL('../test/delta-probe.test.ts',import.meta.url))],{env:{...process.env,DELTA_PROBE_BENCH:'1'},encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
const samples=[...result.stdout.matchAll(/DeltaProbeBenchmark (\{[^\n]+\})/g)].map(m=>JSON.parse(m[1]) as {run:number;api:boolean;wallMs:number});assert.equal(samples.length,8);
const median=(api:boolean)=>samples.filter(s=>s.api===api&&s.run>0).map(s=>s.wallMs).sort((a,b)=>a-b)[1];
const directMs=median(false),apiMs=median(true),maximumMs=directMs*1.3+50;
console.log(JSON.stringify({node:process.version,warmupsPerMode:1,samplesPerMode:3,directMs,apiMs,maximumMs,passed:apiMs<=maximumMs,samples,scope:'Two simulated MCU sessions; two off-center mechanical probe samples with retract and recovery. Direct owner samples precede HTTP product service samples; setup excluded. Test seeds homed coordinates, no physical probe accuracy or complete G28-to-probe acceptance.'},null,2));assert(apiMs<=maximumMs);
