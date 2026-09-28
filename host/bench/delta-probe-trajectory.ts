import assert from 'node:assert/strict';
import {DeltaKinematics} from '../src/kinematics/delta.ts';
import {LookAheadQueue} from '../src/motion/lookahead.ts';
const k=new DeltaKinematics({radius:100,printRadius:100,arms:[250,251,250],angles:[210,331,90],endstops:[300,301,300],stepDistances:[.0125,.00625,.0125],minimumZ:0,maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200});
k.resetPosition('xyz');const samples:number[]=[];
for(let run=0;run<10;run++){
 const start=performance.now();
 for(let i=0;i<10000;i++){
  const x=(i%101)-50,y=((i*7)%101)-50,q=new LookAheadQueue(),move=k.planProbeAxisMove([x,y,10,3],[x,y,0,3],100,2);
  q.add(move);const moves=q.flush();assert.equal(moves.length,1);assert(moves[0].profile);assert.equal(move.maxCruiseV2,400);assert.equal(move.accel,200);assert.deepEqual(move.axesD,[0,0,-10,0]);
 }
 if(run>=3)samples.push(performance.now()-start);
}
console.log(JSON.stringify({node:process.version,warmups:3,trajectoriesPerSample:10000,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Delta off-center probe descent admission and lookahead; validates both endpoints, Z limits and fixed XY/E. Excludes step generation, MCU IO and full probe sampling.'},null,2));
