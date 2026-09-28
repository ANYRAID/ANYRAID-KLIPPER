import {createGuardedBedMeshPort,createMultiExtrusionMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200});kinematics.markHomed([0,1,2]);
const extrusion=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1});
const dual=process.argv.includes('--dual'),samples=[];
for(let round=0;round<8;round++){const options={kinematics,extrusion,canExtrude:()=>true,mesh:null,physicalPosition:[0,0,0,0],limits:motionLimits(300,3000)},port=dual?createMultiExtrusionMeshPort({...options,physicalPosition:[0,0,0,0,0],extruders:[{extrusion,canExtrude:()=>true},{extrusion,canExtrude:()=>true}]}):createGuardedBedMeshPort(options),start=performance.now();for(let i=0;i<100000;i++){port.move(dual?[i%2?0:1,0,0,(i+1)*.01,(i+1)*.02]:[i%2?0:1,0,0,(i+1)*.01],100);if(i%64===63)port.flush();}port.flush();if(round>=3)samples.push(performance.now()-start);}
console.log(JSON.stringify({runtime:process.version,dual,moves:100000,scope:'Extruder admission and lookahead flushing; no MCU IO',samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2]},null,2));
