import {SerialSession} from '../../src/protocol/serial-session.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {serialFirmware} from './serial-firmware.ts';
import {TriggerSyncProtocol} from '../../src/inputs/trsync.ts';
import {EndstopProtocol} from '../../src/inputs/endstop.ts';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../../src/motion/coordinator.ts';
import {MoveQueueSink} from '../../src/motion/move-queue-sink.ts';
import type {HomingRecoveryOptions} from '../../src/homing/recovery.ts';
const signal=()=>new AbortController().signal;
export async function recoveryFixture(count=2,safety?:()=>Promise<void>){
 const fs:Awaited<ReturnType<typeof serialFirmware>>[]=[],sessions:SerialSession[]=[],members:HomingRecoveryOptions['members'][number][]=[],emitters:HomingRecoveryOptions['emitters'][number][]=[],bindings:HomingRecoveryOptions['bindings'][number][]=[];let stops=0,releases=0;
 const q=new TrapQueue();let endstop!:EndstopProtocol;
 for(let i=0;i<count;i++){
  const fw=await serialFirmware(undefined,{triggerSync:true});fs.push(fw);const s=new SerialSession(fw.fd,{async stopDevice(){stops++;await safety?.();}});sessions.push(s);await s.initialize(signal());const trigger=new TriggerSyncProtocol(s.dictionary,8),chip={},e=new EndstopProtocol(chip,s.dictionary,7,{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1});if(i===0)endstop=e;
  await s.configure({oidCount:9,commands:[...trigger.commands,...e.commands]},signal());const queue=s.commandQueue();members.push({session:s,queue,trigger,steppers:[{oid:1,inverted:false}]});
  const settings={frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:s.dictionary.lookup('queue_step oid=%c interval=%u count=%hu add=%hi').id,directionTag:s.dictionary.lookup('set_next_step_dir oid=%c dir=%c').id};
  const id=`s${i}`;bindings.push({id,queue:q,stepper:q.createStepper(settings,'x',.01)});emitters.push({id,queueId:'xyz',member:i,settings,mode:'x',rotationDistance:1,stepsPerRotation:100});fw.setTriggerReason(i?2:1);fw.setStepperPosition(1,100+i);
 }
 const start=sessions[0].clock.sync.getClock(serialClock.now()),sampling=endstop.home({printTime:Number(start)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.trunc(t*1e6)));
 fs[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(start+sampling.restTicks)});
 const sink=new MoveQueueSink(sessions.map((s,i)=>s.motionQueue(`m${i}`,[`s${i}`],t=>bindings[i].stepper.clockAt(t))),async()=>{}),coordinator=new MotionCoordinator(bindings,sink);
 const options:HomingRecoveryOptions={members,primary:0,endstop,sampling,release(){releases++;},coordinator,bindings,emitters,locate:()=>({queues:[{id:'xyz',position:[10,0,0]}],printTime:Math.max(...sessions.map(s=>Number(s.clock.sync.getClock(serialClock.now()))/1e6))+1})};
 return {fs,sessions,options,get stops(){return stops;},get releases(){return releases;},async close(){for(const b of bindings)b.stepper.dispose();q.dispose();for(const s of sessions)await s.stop().catch(()=>{});for(const fw of fs)await fw.close();}};
}
