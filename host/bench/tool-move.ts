import {GCodeMove} from '../src/gcode/move.ts';
import {ToolMovePort} from '../src/gcode/tool-move.ts';
import {createGuardedBedMeshPort,createMultiExtrusionMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:200});kinematics.markHomed([0,1,2]);
const extrusion=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1}),single:number[]=[],tools:number[]=[];
for(let round=0;round<8;round++)for(const multi of round%2?[true,false]:[false,true]){
 const options={kinematics,extrusion,canExtrude:()=>true,mesh:null,physicalPosition:[0,0,0,0],limits:motionLimits(300,3000)},port=multi?createMultiExtrusionMeshPort({...options,physicalPosition:[0,0,0,0,0],extruders:[{extrusion,canExtrude:()=>true},{extrusion,canExtrude:()=>true}]}):createGuardedBedMeshPort(options),mapping=multi?new ToolMovePort(port,2,async()=>{port.flush();}):undefined,gcode=new GCodeMove(mapping??port);
 if(mapping)await mapping.select(1,gcode,new AbortController().signal);gcode.execute('M83');const start=performance.now();
 for(let i=0;i<100000;i++){gcode.execute('G1',{X:i%2?0:1,E:.01});if(i%64===63)port.flush();}port.flush();const elapsed=performance.now()-start;
 if(multi&&port.position()[3]!==0)throw Error('Inactive extruder moved');if(round>=3)(multi?tools:single).push(elapsed);
}
console.log(JSON.stringify({runtime:process.version,scope:'100000 GCodeMove commands, safety admission and lookahead flush; selected second tool vs single extruder, alternating cases, no MCU IO',single:{samplesMs:single,medianMs:[...single].sort((a,b)=>a-b)[2]},tools:{samplesMs:tools,medianMs:[...tools].sort((a,b)=>a-b)[2]}},null,2));
