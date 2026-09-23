import {EndstopProtocol} from '../../src/inputs/endstop.ts';
import type {StoppedEmitter} from '../../src/homing/rebuild-motion.ts';
import {MCUGroup} from '../../src/runtime/mcu-group.ts';
import {SerialSession} from '../../src/protocol/serial-session.ts';
import {serialFirmware} from './serial-firmware.ts';
import {TriggerSyncProtocol} from '../../src/inputs/trsync.ts';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../../src/motion/coordinator.ts';
import {MoveQueueSink} from '../../src/motion/move-queue-sink.ts';
import {CoordinateRebase} from '../../src/homing/recovery.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {compilePWM} from '../../src/outputs/pwm.ts';
export async function rebuiltFixture(dual=false,complete=false,partFan=false){
 const fw=await serialFirmware(undefined,{triggerSync:true}),signal=new AbortController().signal;let stops=0;
 const group=new MCUGroup([{id:'m',async connect(signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal);return s;},async stopDevice(){stops++;}}]);
 const xyz=new TrapQueue(),extrusion=new TrapQueue();let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  await group.start(signal);const s=group.session('m'),trigger=new TriggerSyncProtocol(s.dictionary,8);
  const chip={},endstop=new EndstopProtocol(chip,s.dictionary,7,{chip,chipName:'m',pin:'PA0',invert:0,pullup:1});
  const secondTrigger=new TriggerSyncProtocol(s.dictionary,9),secondEndstop=new EndstopProtocol(chip,s.dictionary,6,{chip,chipName:'m',pin:'PA1',invert:0,pullup:1});
  const fanPlan=partFan?compilePWM(chip,s.dictionary,{oid:0,pin:{chip,chipName:'m',pin:'PA2',invert:0,pullup:0},hardware:true,cycleTime:.01,maxDuration:0,currentPrintTime:Number(s.clock.sync.getClock(serialClock.now()))/1e6},time=>BigInt(Math.trunc(time*1e6))):undefined;
  await s.configure({oidCount:dual?10:9,commands:[...trigger.commands,...endstop.commands,...dual?[...secondTrigger.commands,...secondEndstop.commands]:[],...fanPlan?.commands??[]],...fanPlan?{init:fanPlan.init,restart:fanPlan.restart,reservedMoves:fanPlan.reservedMoves}:{}},signal);
  const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};
  const x=xyz.createStepper({...settings,oid:3},'x',.01),e=extrusion.createStepper({...settings,oid:4},'extruder',.01);
  const bindings=[{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}];if(dual)bindings.push({id:'x2',queue:xyz,stepper:xyz.createStepper({...settings,oid:5},'x',.01)});
  if(complete)for(const [id,oid] of [['y',1],['z',2]] as const)bindings.push({id,queue:xyz,stepper:xyz.createStepper({...settings,oid},id,.01)});
  const sink=new MoveQueueSink([group.motionQueue('m',bindings.map(b=>b.id),t=>x.clockAt(t))],async()=>{}),coordinator=new MotionCoordinator(bindings,sink);
  const members=[{session:s,queue:s.commandQueue(),trigger,steppers:[{oid:3,inverted:false},{oid:4,inverted:false}]}];
  fw.setTriggerReason(2);fw.setStepperPosition(3,100);fw.setStepperPosition(4,20);
  const emitters:StoppedEmitter[]=[{id:'x',queueId:'xyz',member:0,settings:{...settings,oid:3},mode:'x',rotationDistance:1,stepsPerRotation:100},{id:'e',queueId:'e',member:0,settings:{...settings,oid:4},mode:'extruder',rotationDistance:1,stepsPerRotation:100}];
  if(dual){members[0].steppers.push({oid:5,inverted:false});emitters.push({id:'x2',queueId:'xyz',member:0,settings:{...settings,oid:5},mode:'x',rotationDistance:1,stepsPerRotation:100});fw.setStepperPosition(5,300);}
  if(complete)for(const [id,oid] of [['y',1],['z',2]] as const){members[0].steppers.push({oid,inverted:false});emitters.push({id,queueId:'xyz',member:0,settings:{...settings,oid},mode:id,rotationDistance:1,stepsPerRotation:100});fw.setStepperPosition(oid,0);}
  const result=await new CoordinateRebase({coordinator,bindings,members,emitters,locate:()=>({queues:[{id:'xyz',position:[50,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(s.clock.sync.getClock(serialClock.now()))/1e6+.2})}).recover(signal);
  motion=result.motion;const options={group,members,motion,routes:[{queue:motion.bindings[0].queue},{queue:motion.bindings[1].queue,extrusionAxis:3}],position:[50,0,0,2]};
  return {options,fw,emitters,endstop,secondTrigger,secondEndstop,fanPlan,get stops(){return stops;},async close(){await group.stop();motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();}};
 }catch(error){await group.stop().catch(()=>{});motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();throw error;}
}
