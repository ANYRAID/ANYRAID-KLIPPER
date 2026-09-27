import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import type {ConfiguredEndstopPhase} from '../../src/config/endstop-phase.ts';
import type {TmcSensorlessMode} from '../../src/drivers/tmc-sensorless.ts';
import {snapshotPrintClock} from '../../src/timing/print-clock.ts';
import {PrintClockTimeline} from '../../src/timing/print-clock-timeline.ts';
import {SecondarySync} from '../../src/timing/secondary-sync.ts';
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
export async function nativeLinearFixture(retractDistance=0,canExtrude=()=>false,filtered=false,fanConfig?:FanConfig,motorPower:boolean|'always'|'mixed'=false,auxiliary=false,synchronized=false,probe?:Record<string,string>,sensorless?:TmcSensorlessMode,endstopPhases?:readonly ConfiguredEndstopPhase[],probeHome=false){
 const f=await rebuiltFixture(false,true,fanConfig!==undefined,motorPower,auxiliary);let fan:ScheduledCoolingFan|undefined,timeline:FanBoundaryTimeline|undefined;
 try{
  if(fanConfig){const group=f.options.group,s=group.session(f.fanMCU),stepper=f.options.motion.bindings[0].stepper,mapping=snapshotPrintClock(stepper.calibration),pwm=new GenerationPWMOutput(f.fanPlan!,s.dictionary,group.commandQueue(f.fanMCU),group.commandQueue(f.fanMCU),mapping.clockAt,mapping.printTimeAtClock);fan=new ScheduledCoolingFan(pwm,fanConfig);await fan.start(signal());timeline=new FanBoundaryTimeline(fan);}
  const clockTimelines=synchronized?['m','a'].map(id=>({id,timeline:new PrintClockTimeline({offset:0,frequency:1e6}),synchronizer:id==='m'?new SecondarySync(f.options.group.session('a').clock.sync,f.options.group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0}):undefined})):undefined;
  const generation=await bindRebuiltMotion({...f.options,clockTimelines,...timeline?{boundaryOutput:{output:timeline,mcu:f.fanMCU}}:{}});
  if(filtered){generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});generation.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
  const groups=[{sensorless,members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  let reader=linearMotionReader({...Object.fromEntries(['stepper_x','stepper_y','stepper_z'].map(name=>[name,{homing_retract_dist:String(retractDistance)}])),...(probe?{probe}:{})});
  if(probeHome){const raw=structuredClone(reader.source.original);delete raw.stepper_z.position_endstop;raw.stepper_z.endstop_pin='probe:z_virtual_endstop';reader=new ConfigurationReader(new ConfigurationSource('/probe-home.cfg',raw,[]),null);}
  const {port,kinematics,rails}=createConfiguredNativeLinearPort(reader,{endstopPhases,generation,emitters:f.emitters,kinematicIds:['x','y','z'],probeGroups:groups,groupsByAxis:[groups,groups,groups],endstopNames:[['test'],['test'],['test']],canExtrude});
  const coordinates=new GCodeMove(port);
  const command=new LinearHomingCommand(kinematics,coordinates,port,rails,5000);
  return {f,generation,groups,port,kinematics,coordinates,command,fan,timeline,async close(){await port.dispose();await f.close();await timeline?.stop();}};
 }catch(error){await f.close();await timeline?.stop();throw error;}
}
export async function nativeStreamStarted(t:Awaited<ReturnType<typeof nativeLinearFixture>>){
 const {setTimeout:delay}=await import('node:timers/promises'),deadline=performance.now()+3000;
 while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline,'native stream did not start');await delay(2);}
}
