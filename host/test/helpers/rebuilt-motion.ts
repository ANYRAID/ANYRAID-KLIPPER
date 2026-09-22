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
export async function rebuiltFixture(){
 const fw=await serialFirmware(undefined,{triggerSync:true}),signal=new AbortController().signal;let stops=0;
 const group=new MCUGroup([{id:'m',async connect(signal,stopDevice){const s=new SerialSession(fw.fd,{stopDevice});await s.initialize(signal);return s;},async stopDevice(){stops++;}}]);
 const xyz=new TrapQueue(),extrusion=new TrapQueue();let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  await group.start(signal);const s=group.session('m'),trigger=new TriggerSyncProtocol(s.dictionary,8);
  const chip={},endstop=new EndstopProtocol(chip,s.dictionary,7,{chip,chipName:'m',pin:'PA0',invert:0,pullup:1});
  await s.configure({oidCount:9,commands:[...trigger.commands,...endstop.commands]},signal);
  const settings={frequency:1e6,timeOffset:0,maxError:0,queueStepTag:8,directionTag:9};
  const x=xyz.createStepper({...settings,oid:3},'x',.01),e=extrusion.createStepper({...settings,oid:4},'extruder',.01);
  const bindings=[{id:'x',queue:xyz,stepper:x},{id:'e',queue:extrusion,stepper:e}];
  const sink=new MoveQueueSink([group.motionQueue('m',['x','e'],t=>x.clockAt(t))],async()=>{}),coordinator=new MotionCoordinator(bindings,sink);
  const members=[{session:s,queue:s.commandQueue(),trigger,steppers:[{oid:3,inverted:false},{oid:4,inverted:false}]}];
  fw.setTriggerReason(2);fw.setStepperPosition(3,100);fw.setStepperPosition(4,20);
  const emitters:StoppedEmitter[]=[{id:'x',queueId:'xyz',member:0,settings:{...settings,oid:3},mode:'x',rotationDistance:1,stepsPerRotation:100},{id:'e',queueId:'e',member:0,settings:{...settings,oid:4},mode:'extruder',rotationDistance:1,stepsPerRotation:100}];
  const result=await new CoordinateRebase({coordinator,bindings,members,emitters,locate:()=>({queues:[{id:'xyz',position:[50,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(s.clock.sync.getClock(serialClock.now()))/1e6+.2})}).recover(signal);
  motion=result.motion;const options={group,members,motion,routes:[{queue:motion.bindings[0].queue},{queue:motion.bindings[1].queue,extrusionAxis:3}],position:[50,0,0,2]};
  return {options,fw,emitters,endstop,get stops(){return stops;},async close(){await group.stop();motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();}};
 }catch(error){await group.stop().catch(()=>{});motion?.dispose();xyz.dispose();extrusion.dispose();await fw.close();throw error;}
}
