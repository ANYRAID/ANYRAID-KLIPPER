import assert from 'node:assert/strict';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {createConfiguredNativeLinearPort} from '../src/config/linear-motion.ts';
const values={manual:[] as number[],owned:[] as number[]};
for(let run=0;run<14;run++)for(const mode of (run%2?['manual','owned']:['owned','manual']) as ('manual'|'owned')[]){
 const f=await initialLinearFixture(!!(run%2));let port:ReturnType<typeof createConfiguredNativeLinearPort>['port']|undefined;
 try{
  const start=performance.now(),result=mode==='owned'?f.initial.createLinearPort(f.reader,f.settings):createConfiguredNativeLinearPort(f.reader,{...f.settings,canExtrude:()=>f.hardware.analog[0].runtime.canExtrude(),generation:f.initial.generation,emitters:f.initial.emitters});
  const elapsed=performance.now()-start;port=result.port;
  assert.equal(result.kinematics.status.homedAxes,'');assert.deepEqual(port.position(),[0,0,0,0]);assert.throws(()=>port!.move([1,0,0,0],10),/home/i);assert.equal(f.firmware[0].motion.length,0);
  if(run>=3)values[mode].push(elapsed);
 }finally{if(mode==='manual')await port?.dispose();await f.hardware.close();await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},manual=stats(values.manual),owned=stats(values.owned);
console.log(JSON.stringify({node:process.version,warmup:3,samples:11,manual,owned,scope:'Same configured XYZE native hardware, direct linear factory versus owned handoff. Excludes MCU connection/configuration, native initialization, and close. No hardware proof.'}));
assert(owned.medianMs<manual.medianMs*1.5+.2,'Owned linear handoff median regression');assert(owned.p95Ms<manual.p95Ms*2+.5,'Owned linear handoff p95 regression');
