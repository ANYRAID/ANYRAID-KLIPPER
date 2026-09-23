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
import {GenerationPWMOutput} from '../../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan,type FanConfig} from '../../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../../src/outputs/fan-boundaries.ts';
const signal=()=>new AbortController().signal;
export async function nativeLinearFixture(retractDistance=0,canExtrude=()=>false,filtered=false,fanConfig?:FanConfig){
 const f=await rebuiltFixture(false,true,fanConfig!==undefined);let fan:ScheduledCoolingFan|undefined,timeline:FanBoundaryTimeline|undefined;
 try{
  if(fanConfig){const group=f.options.group,s=group.session('m'),stepper=f.options.motion.bindings[0].stepper,pwm=new GenerationPWMOutput(f.fanPlan!,s.dictionary,group.commandQueue('m'),group.commandQueue('m'),t=>stepper.clockAt(t),c=>stepper.printTimeAtClock(c));fan=new ScheduledCoolingFan(pwm,fanConfig);await fan.start(signal());timeline=new FanBoundaryTimeline(fan);}
  const generation=await bindRebuiltMotion({...f.options,...timeline?{boundaryOutput:{output:timeline,member:0}}:{}}),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,52],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
  if(filtered){generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});generation.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  const port=new NativeLinearHomingPort({generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],limits:motionLimits(100,1000),extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude});
  const coordinates=new GCodeMove(port),rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance,retractSpeed:10,secondSpeed:5,endstops:['test']}));
  const command=new LinearHomingCommand(kinematics,coordinates,port,rails,5000);
  return {f,generation,port,kinematics,coordinates,command,fan,timeline,async close(){await port.dispose();await f.close();await timeline?.stop();}};
 }catch(error){await f.close();await timeline?.stop();throw error;}
}
export async function nativeStreamStarted(t:Awaited<ReturnType<typeof nativeLinearFixture>>){
 const {setTimeout:delay}=await import('node:timers/promises'),deadline=performance.now()+3000;
 while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline,'native stream did not start');await delay(2);}
}
