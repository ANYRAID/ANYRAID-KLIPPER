import assert from 'node:assert/strict';
import {DeltaKinematics} from '../src/kinematics/delta.ts';
import {LookAheadQueue} from '../src/motion/lookahead.ts';
const k=new DeltaKinematics({radius:100,printRadius:100,arms:[250,251,250],angles:[210,331,90],endstops:[300,301,300],stepDistances:[.0125,.00625,.0125],minimumZ:0,maxVelocity:300,maxAccel:3000,maxZVelocity:100,maxZAccel:1000});
const home=k.homePosition,start=[home[0]+.01,home[1]-.02,home[2]+.03,0],end=[home[0],home[1],home[2]-5,0],samples:number[]=[];
for(let run=0;run<10;run++){
 const before=performance.now();
 for(let n=0;n<10000;n++){const q=new LookAheadQueue();q.add(k.planHomingAxisMove(start,end,10,2));const moves=q.flush();assert.equal(moves.length,1);assert(moves[0].profile);assert.equal(k.status.homedAxes,'');}
 if(run>=3)samples.push(performance.now()-before);
}
console.log(JSON.stringify({node:process.version,warmups:3,trajectoriesPerSample:10000,samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3],scope:'Delta privileged retract geometry, limits and lookahead profile; excludes native step generation, MCU IO and print throughput'},null,2));
