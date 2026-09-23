import {snapshotPrintClock} from '../../src/timing/print-clock.ts';
import assert from 'node:assert/strict';
import {createConfiguredNativeLinearPort} from '../../src/config/linear-motion.ts';
import {linearMotionReader} from './linear-motion-config.ts';
import {LinearHomingCommand} from '../../src/homing/linear-command.ts';
import {GCodeMove} from '../../src/gcode/move.ts';
import {inputShaper} from '../../src/motion/shaper.ts';
import {bindRebuiltMotion} from '../../src/runtime/rebuilt-motion.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {rebuiltFixture} from './rebuilt-motion.ts';
import {GenerationPWMOutput} from '../../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan,type FanConfig} from '../../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../../src/outputs/fan-boundaries.ts';
const signal=()=>new AbortController().signal;
export async function nativeLinearFixture(retractDistance=0,canExtrude=()=>false,filtered=false,fanConfig?:FanConfig,motorPower:boolean|'always'|'mixed'=false,auxiliary=false){
 const f=await rebuiltFixture(false,true,fanConfig!==undefined,motorPower,auxiliary);let fan:ScheduledCoolingFan|undefined,timeline:FanBoundaryTimeline|undefined;
 try{
  if(fanConfig){const group=f.options.group,s=group.session(f.fanMCU),stepper=f.options.motion.bindings[0].stepper,mapping=snapshotPrintClock(stepper.calibration),pwm=new GenerationPWMOutput(f.fanPlan!,s.dictionary,group.commandQueue(f.fanMCU),group.commandQueue(f.fanMCU),mapping.clockAt,mapping.printTimeAtClock);fan=new ScheduledCoolingFan(pwm,fanConfig);await fan.start(signal());timeline=new FanBoundaryTimeline(fan);}
  const generation=await bindRebuiltMotion({...f.options,...timeline?{boundaryOutput:{output:timeline,mcu:f.fanMCU}}:{}});
  if(filtered){generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});generation.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  const reader=linearMotionReader(Object.fromEntries(['stepper_x','stepper_y','stepper_z'].map(name=>[name,{homing_retract_dist:String(retractDistance)}])));
  const {port,kinematics,rails}=createConfiguredNativeLinearPort(reader,{generation,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],endstopNames:[['test'],['test'],['test']],canExtrude});
  const coordinates=new GCodeMove(port);
  const command=new LinearHomingCommand(kinematics,coordinates,port,rails,5000);
  return {f,generation,port,kinematics,coordinates,command,fan,timeline,async close(){await port.dispose();await f.close();await timeline?.stop();}};
 }catch(error){await f.close();await timeline?.stop();throw error;}
}
export async function nativeStreamStarted(t:Awaited<ReturnType<typeof nativeLinearFixture>>){
 const {setTimeout:delay}=await import('node:timers/promises'),deadline=performance.now()+3000;
 while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline,'native stream did not start');await delay(2);}
}
