import {recoveryFixture} from './homing-recovery.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {EndstopProtocol} from '../../src/inputs/endstop.ts';
import {TriggerSyncProtocol} from '../../src/inputs/trsync.ts';
import type {HomingStopGroup} from '../../src/homing/stop-set.ts';
export async function stopSetFixture(shared=false,safety?:()=>Promise<void>){
 const f=await recoveryFixture(shared?1:2,safety),groups:HomingStopGroup[]=[];
 for(let i=0;i<2;i++){
  const base=f.options.members[shared?0:i],session=base.session,chip={},endstop=shared&&i?new EndstopProtocol(chip,session.dictionary,5,{chip,chipName:'mcu',pin:'PA1',invert:0,pullup:1}):f.options.endstop;
  const trigger=shared&&i?new TriggerSyncProtocol(session.dictionary,6):base.trigger;
  const member={...base,trigger,queue:shared&&i?session.commandQueue():base.queue,steppers:[{oid:shared&&i?2:1,inverted:false}]};
  const clock=session.clock.sync.getClock(serialClock.now())-BigInt(10000+i*1000);
  const sampling=endstop.home({printTime:Number(clock)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:trigger.oid},t=>BigInt(Math.round(t*1e6)));
  f.fs[shared?0:i].setTriggerReason(1,trigger.oid);f.fs[shared?0:i].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock+sampling.restTicks)},endstop.oid);f.fs[shared?0:i].setStepperPosition(member.steppers[0].oid,100+i);
  groups.push({members:[member],primary:0,endstop,sampling});
 }
 return {f,groups};
}
