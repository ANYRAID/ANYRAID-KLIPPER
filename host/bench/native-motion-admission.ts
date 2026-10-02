import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {nativeLinearFixture} from '../test/helpers/native-linear-port.ts';
import {createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
const samples:number[][]=[[],[]],count=10000;
for(let run=0;run<14;run++){
 const t=await nativeLinearFixture();try{
  t.kinematics.markHomed([0]);const baseline=createGuardedBedMeshPort({mesh:null,physicalPosition:[50,0,0,2],limits:motionLimits(100,1000),kinematics:t.kinematics,extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude:()=>false});
  const targets=Array.from({length:count},(_,i)=>[i%2?50:51,0,0,2]);
  for(const native of run%2?[1,0]:[0,1]){
   const port=native?t.port:baseline,start=performance.now();for(const target of targets)port.move(target,10);const elapsed=performance.now()-start;if(run>=3)samples[native].push(elapsed);
  }
  assert.equal(t.port.status.pendingMoves,count);assert.equal(baseline.pending,count);assert.deepEqual(t.port.position(),baseline.plannedPosition);baseline.shutdown();
 }finally{await t.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,moves:count,samples:11,guarded:stats(samples[0]),native:stats(samples[1]),scope:'Same guarded XYZE admission and lookahead, alternating order, native port ownership and active-group checks; no pulse generation, transport or printer throughput claim.'}));
assert(samples[1][5]<=samples[0][5]*1.3+2,'Native ownership admission exceeds 30% plus 2ms per 10000 moves');
