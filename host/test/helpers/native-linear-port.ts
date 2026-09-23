import assert from 'node:assert/strict';
import {NativeLinearHomingPort} from '../../src/homing/native-linear-port.ts';
import {LinearHomingCommand} from '../../src/homing/linear-command.ts';
import {LinearKinematics} from '../../src/kinematics/linear.ts';
import {GCodeMove} from '../../src/gcode/move.ts';
import {ExtrusionGuard} from '../../src/motion/extrusion.ts';
import {inputShaper} from '../../src/motion/shaper.ts';
import {motionLimits} from '../../src/motion/lookahead.ts';
import {bindRebuiltMotion} from '../../src/runtime/rebuilt-motion.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {rebuiltFixture} from './rebuilt-motion.ts';
const signal=()=>new AbortController().signal;
export async function nativeLinearFixture(retractDistance=0,canExtrude=()=>false,filtered=false){
 const f=await rebuiltFixture(false,true);
 try{
  const generation=await bindRebuiltMotion(f.options),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,52],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
  if(filtered){generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});generation.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  const port=new NativeLinearHomingPort({generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],limits:motionLimits(100,1000),extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude});
  const coordinates=new GCodeMove(port),rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance,retractSpeed:10,secondSpeed:5,endstops:['test']}));
  const command=new LinearHomingCommand(kinematics,coordinates,port,rails,5000);
  return {f,generation,port,kinematics,coordinates,command,async close(){await port.dispose();await f.close();}};
 }catch(error){await f.close();throw error;}
}
export async function nativeStreamStarted(t:Awaited<ReturnType<typeof nativeLinearFixture>>){
 const {setTimeout:delay}=await import('node:timers/promises'),deadline=performance.now()+3000;
 while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline,'native stream did not start');await delay(2);}
}
