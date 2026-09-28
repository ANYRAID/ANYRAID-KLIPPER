import assert from 'node:assert/strict';
import {LinearKinematics,type LinearConfig} from '../src/kinematics/linear.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const limits=motionLimits(300,3000),iterations=100000,results=[];
for(const kind of ['cartesian','corexy','corexz','hybrid_corexy','hybrid_corexz'] as const){
 const config:LinearConfig={kind,ranges:[[0,200],[0,200],[0,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:10,maxZAccel:100},k=new LinearKinematics(config);k.markHomed([0,1,2]);const samples=[];
 for(let run=0;run<6;run++){const start=performance.now();let checksum=0;
  for(let i=0;i<iterations;i++){const x=i%1024/8,y=i%512/8,z=i%256/8,motors=kind==='cartesian'?[x,y,z]:kind==='corexy'?[x+y,x-y,z]:kind==='corexz'?[x+z,y,x-z]:kind==='hybrid_corexy'?[x-y,y,z]:[x-z,y,z],p=k.calcPosition(motors);assert(p[0]===x&&p[1]===y&&p[2]===z);const move=new Move(limits,[x,y,z,0],[x+.5,y+.25,z+.125,0],100);k.check(move);checksum+=p[0]+move.accel;}
  assert(Number.isFinite(checksum)&&checksum>0);if(run)samples.push(performance.now()-start);
 }
 const medianMs=[...samples].sort((a,b)=>a-b)[2];results.push({kind,samplesMs:samples,medianMs,movesPerSecond:iterations/(medianMs/1000)});
}
process.stdout.write(JSON.stringify({node:process.version,iterations,results,scope:'Local position reconstruction, exact binary-fraction equality, Move creation and admission including Z speed limit. Warm process; excludes native step generation and hardware.'},null,2)+'\n');
