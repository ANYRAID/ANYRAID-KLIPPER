import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {EndstopVerification} from '../src/homing/endstop-verification.ts';
import {EndstopProtocol} from '../src/inputs/endstop.ts';
import {TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {compilePWM,PWMOutput} from '../src/outputs/pwm.ts';
import {BLTouchDevice} from '../src/homing/bltouch-device.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const fw=await serialFirmware(undefined,{triggerSync:true});let stops=0;const session=new SerialSession(fw.fd,{async stopDevice(){stops++;}});await session.initialize(signal());const chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);
 const clockAt=(t:number)=>BigInt(Math.round(t*1e6)),printAt=(c:bigint)=>Number(c)/1e6,now=()=>printAt(session.clock.sync.getClock(serialClock.now()));
 const endstop=new EndstopProtocol(chip,session.dictionary,1,pins.lookup('^PA0',{canPullup:true})),trigger=new TriggerSyncProtocol(session.dictionary,2),pwmConfig=compilePWM(chip,session.dictionary,{oid:0,pin:pins.lookup('PA1'),cycleTime:.02,maxDuration:0,currentPrintTime:now()},clockAt);await session.configure({oidCount:3,commands:[...endstop.commands,...trigger.commands,...pwmConfig.commands],restart:[...endstop.restart,...trigger.restart],init:pwmConfig.init,reservedMoves:1},signal());
 const waitUntil=async(t:number,s:AbortSignal)=>{while(session.clock.sync.getClock(serialClock.now())<clockAt(t))await delay(2,undefined,{signal:s});};
 const pwm=new PWMOutput(pwmConfig,session.dictionary,session.commandQueue(),clockAt,printAt);
 const verifier=new EndstopVerification(session,session.commandQueue(),endstop,trigger,clockAt,waitUntil);
 return {fw,session,verifier,clockAt,pwm,now,waitUntil,printAt,get stops(){return stops;},options(){const time=Number(session.clock.sync.getClock(serialClock.now()+.15)) /1e6;return {time,until:time+.1,triggered:true,sampleTime:.000015,sampleCount:4,restTime:.001};},async close(){await session.stop();await fw.close();}};
}
for(const hit of [false,true])test(`stationary verification returns authoritative MCU ${hit?'hit':'deadline'} without stepper commands`,async()=>{
 const f=await fixture();try{const o=f.options(),start=f.clockAt(o.time);f.fw.setTriggerReason(hit?1:3,2);f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(BigInt.asUintN(32,start+1000n))},1);
  assert.equal(await f.verifier.verify(o,signal()),hit);assert.equal(f.stops,0);assert.equal(f.fw.motion.length,0);assert(!f.fw.outputs.some(p=>p.name==='stepper_stop_on_trigger'));const starts=f.fw.outputs.filter(p=>p.name==='trsync_start');assert.equal(starts.at(-1)!.parameters.expire_reason,3);assert.equal(starts.at(-1)!.parameters.report_ticks,0);const sampling=f.fw.outputs.filter(p=>p.name==='endstop_home');assert.equal(sampling.at(-1)!.parameters.sample_count,0);assert(sampling.some(p=>p.parameters.sample_count===4&&p.parameters.pin_value===1));
 }finally{await f.close();}
});
for(const reason of [0,2,4])test(`unarmed, premature host stop and communication faults are not a normal no-hit (${reason})`,async()=>{
 const f=await fixture();try{f.fw.setTriggerReason(reason,2);await assert.rejects(f.verifier.verify(f.options(),signal()),/confirm verification/);assert.equal(f.stops,1);assert(f.verifier.status.failed);}finally{await f.close();}
});
test('stale hit clock is rejected even when raw GPIO matches the desired state',async()=>{
 const f=await fixture();try{const o=f.options();f.fw.setTriggerReason(1,2);f.fw.setEndstopState({homing:0,pin_value:1,next_clock:Number(f.clockAt(o.time)-1000n)},1);await assert.rejects(f.verifier.verify(o,signal()),/predates/);assert.equal(f.stops,1);}finally{await f.close();}
});
test('cancellation stops the session and prevents verifier reuse',async()=>{
 const f=await fixture();try{const abort=new AbortController(),pending=f.verifier.verify(f.options(),abort.signal),rejected=assert.rejects(pending,/cancel verification/);await delay(20);await assert.rejects(f.verifier.verify(f.options(),signal()),/unavailable/);abort.abort(Error('cancel verification'));await rejected;assert.equal(f.stops,1);assert(!f.verifier.status.busy);await assert.rejects(f.verifier.verify(f.options(),signal()),/unavailable/);}finally{await f.close();}
});
test('host timeout remains a fault and never becomes an MCU no-hit result',async()=>{
 const f=await fixture();try{f.fw.setTriggerReason(3,2);await assert.rejects(f.verifier.verify(f.options(),signal(),20),/timed out/);assert.equal(f.stops,1);assert(f.verifier.status.failed);}finally{await f.close();}
});
test('expired window is rejected before writes and ongoing sampling cannot be accepted',async()=>{
 const f=await fixture();try{const before=f.fw.outputs.length;await assert.rejects(f.verifier.verify({...f.options(),time:0,until:.1},signal()),/expired/);assert.equal(f.fw.outputs.length,before);assert.equal(f.stops,0);f.fw.setTriggerReason(3,2);f.fw.setEndstopState({homing:1,pin_value:0,next_clock:0},1);await assert.rejects(f.verifier.verify(f.options(),signal()),/sampling did not stop/);assert.equal(f.stops,1);}finally{await f.close();}
});
test('BLTouch lifecycle uses native PWM and independently confirmed sensor sampling on one MCU',async t=>{
 const f=await fixture();try{
  let verifications=0,seeks=0;const device=new BLTouchDevice({clockAt:f.clockAt,printAt:f.printAt,secondsToClock:t=>BigInt(Math.trunc(t*1e6)),estimatedPrintTime:f.now,motionPrintTime:f.now,waitUntil:f.waitUntil,setPWM:(...args)=>f.pwm.setPWM(...args),stop:reason=>f.session.stop(reason),async verifyState(o,s){verifications++;f.fw.setTriggerReason(1,2);f.fw.setEndstopState({homing:0,pin_value:Number(o.triggered),next_clock:Number(BigInt.asUintN(32,f.clockAt(o.time)+1000n))},1);return f.verifier.verify(o,s);}},{pinMoveTime:.68,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:true,outputMode:null});
  const start=performance.now();await device.initialize(signal());await device.session(sample=>sample(async()=>{seeks++;assert(device.status.deployed);return 42;}),signal());
  assert.equal(device.status.phase,'idle');assert(!device.status.deployed);assert.equal(verifications,3);assert.equal(seeks,1);assert.equal(f.stops,0);assert.equal(f.fw.motion.length,0);const duties=f.fw.outputs.filter(p=>p.name==='queue_digital_out').map(p=>p.parameters.on_ticks);assert(duties.includes(650));assert(duties.includes(1475));assert(duties.includes(1165));assert.equal(duties.at(-1),0);t.diagnostic(JSON.stringify({nativeLifecycleMs:performance.now()-start,verifications,simulatedSeekCalls:seeks,physicalMotion:false}));
 }finally{await f.close();}
});
