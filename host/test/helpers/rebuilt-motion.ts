import {compileConfiguredHoming} from '../../src/config/homing.ts';
import {compileConfiguredMotorEnables} from '../../src/config/motor-enable.ts';
import {PrinterPins} from '../../src/protocol/pins.ts';
import {mcuOids} from '../../src/protocol/mcu-oids.ts';
import {readStepperDistance} from '../../src/config/stepper.ts';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {MotorEnable} from '../../src/outputs/motor-enable.ts';
import type {StoppedEmitter} from '../../src/homing/rebuild-motion.ts';
import {MCUGroup} from '../../src/runtime/mcu-group.ts';
import {SerialSession} from '../../src/protocol/serial-session.ts';
import {serialFirmware} from './serial-firmware.ts';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../../src/motion/coordinator.ts';
import {MoveQueueSink} from '../../src/motion/move-queue-sink.ts';
import {CoordinateRebase} from '../../src/homing/recovery.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {compilePWM} from '../../src/outputs/pwm.ts';
export async function rebuiltFixture(dual=false,complete=false,partFan=false,motorPower:boolean|'always'|'mixed'=false){
 const fw=await serialFirmware(undefined,{triggerSync:true}),signal=new AbortController().signal;let stops=0;
 const group=new MCUGroup([{id:'m',async connect(signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal);return s;},async stopDevice(){stops++;}}]);
 const xyz=new TrapQueue(),extrusion=new TrapQueue();let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  await group.start(signal);const s=group.session('m'),chip={},pins=new PrinterPins<object>();pins.register('m',chip);
  // Reserve only legacy stepper/fan objects and compatibility gaps.
  const legacyIds=[0,1,2,3,4,5,...dual?[]:[6],...motorPower&&!dual?[9]:[]];
  mcuOids(pins).claim(legacyIds.map(oid=>({mcu:'m',owner:'fixture:'+oid,oid})),()=>null);
  const homingReader=new ConfigurationReader(new ConfigurationSource('/endstops.cfg',{primary:{endstop_pin:'^m:PA0'},secondary:{endstop_pin:'^m:PA1'}},[]),null);
  const homing=compileConfiguredHoming(homingReader,pins,new Map([['m',{chip,dictionary:s.dictionary}]]),[{section:'primary',oid:7,triggers:[{mcu:'m',oid:8}]},...dual?[{section:'secondary',oid:6,triggers:[{mcu:'m',oid:9}]}]:[]]);
  const {endstop}=homing[0],trigger=homing[0].triggers[0].protocol,secondary=homing[1];
  const fanPlan=partFan?compilePWM(chip,s.dictionary,{oid:0,pin:{chip,chipName:'m',pin:'PA2',invert:0,pullup:0},hardware:true,cycleTime:.01,maxDuration:0,currentPrintTime:Number(s.clock.sync.getClock(serialClock.now()))/1e6},time=>BigInt(Math.trunc(time*1e6))):undefined;
  const motorIds=['x','e',...dual?['x2']:[],...complete?['y','z']:[]],motorReader=new ConfigurationReader(new ConfigurationSource('/motors.cfg',Object.fromEntries(motorIds.map(id=>[id,motorPower==='always'||motorPower==='mixed'&&id==='e'?{} as Record<string,string>:{enable_pin:'!m:PA3'}])),[]),null);
  const motorPlans=motorPower?compileConfiguredMotorEnables(motorReader,pins,group,motorIds.map(id=>({section:id,emitter:id,mcu:'m',leadTime:.001,calibration:{offset:0,frequency:1e6}}))):undefined;
  const motorPlan=motorPlans?.lines[0];
  const motorOidCount=mcuOids(pins).finalize('m').oidCount;
  await s.configure({oidCount:motorOidCount,commands:[...trigger.commands,...endstop.commands,...secondary?[...secondary.triggers[0].protocol.commands,...secondary.endstop.commands]:[],...fanPlan?.commands??[],...motorPlan?[motorPlan.config.config]:[]],init:fanPlan?.init,restart:[...fanPlan?.restart??[],...motorPlan?[motorPlan.config.restart]:[]],reservedMoves:(fanPlan?.reservedMoves??0)+(motorPlan?.config.reservedMoves??0)},signal);
  const motorEnable=motorPlans?new MotorEnable(group,motorPlans.lines,motorPlans.alwaysOn):undefined;
  const distance=readStepperDistance(new ConfigurationReader(new ConfigurationSource('/stepper.cfg',{stepper_x:{rotation_distance:'1',microsteps:'1',full_steps_per_rotation:'100'}},[]),null).section('stepper_x'));
  const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};
  const x=xyz.createStepper({...settings,oid:3},'x',distance.stepDistance),e=extrusion.createStepper({...settings,oid:4},'extruder',distance.stepDistance);
  const bindings=[{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}];if(dual)bindings.push({id:'x2',queue:xyz,stepper:xyz.createStepper({...settings,oid:5},'x',distance.stepDistance)});
  if(complete)for(const [id,oid] of [['y',1],['z',2]] as const)bindings.push({id,queue:xyz,stepper:xyz.createStepper({...settings,oid},id,distance.stepDistance)});
  const sink=new MoveQueueSink([group.motionQueue('m',bindings.map(b=>b.id),t=>x.clockAt(t))],async()=>{}),coordinator=new MotionCoordinator(bindings,sink);
  const members=[{session:s,queue:s.commandQueue(),trigger,steppers:[{oid:3,inverted:false},{oid:4,inverted:false}]}];
  fw.setTriggerReason(2);fw.setStepperPosition(3,100);fw.setStepperPosition(4,20);
  const emitters:StoppedEmitter[]=[{id:'x',queueId:'xyz',member:0,settings:{...settings,oid:3},mode:'x',rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation},{id:'e',queueId:'e',member:0,settings:{...settings,oid:4},mode:'extruder',rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation}];
  if(dual){members[0].steppers.push({oid:5,inverted:false});emitters.push({id:'x2',queueId:'xyz',member:0,settings:{...settings,oid:5},mode:'x',rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation});fw.setStepperPosition(5,300);}
  if(complete)for(const [id,oid] of [['y',1],['z',2]] as const){members[0].steppers.push({oid,inverted:false});emitters.push({id,queueId:'xyz',member:0,settings:{...settings,oid},mode:id,rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation});fw.setStepperPosition(oid,0);}
  const result=await new CoordinateRebase({coordinator,bindings,members,emitters,locate:()=>({queues:[{id:'xyz',position:[50,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(s.clock.sync.getClock(serialClock.now()))/1e6+.2})}).recover(signal);
  motion=result.motion;const options={group,members,motion,motorEnable,routes:[{queue:motion.bindings[0].queue},{queue:motion.bindings[1].queue,extrusionAxis:3}],position:[50,0,0,2]};
  return {options,fw,emitters,endstop,get secondTrigger(){if(!secondary)throw new Error('Secondary homing group is not configured');return secondary.triggers[0].protocol;},get secondEndstop(){if(!secondary)throw new Error('Secondary homing group is not configured');return secondary.endstop;},fanPlan,motorPlan,get stops(){return stops;},async close(){await group.stop();motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();}};
 }catch(error){await group.stop().catch(()=>{});motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();throw error;}
}
