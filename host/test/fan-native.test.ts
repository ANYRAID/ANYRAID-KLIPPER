import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
import {compilePWM} from '../src/outputs/pwm.ts';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
for(const hardware of [false,true])test(`cooling fan ${hardware?'hardware':'software'} generation sends kick, settle and confirmed reset`,async()=>{
 const fw=await serialFirmware(),session=new SerialSession(fw.fd,{async stopDevice(){}}),signal=new AbortController().signal;let fan:ScheduledCoolingFan|undefined;
 try{
  await session.initialize(signal);const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6)),now=Number(session.clock.sync.getClock(serialClock.now()))/1e6;
  const config=compilePWM(chip,session.dictionary,{oid:3,pin:{chip,chipName:'m',pin:'PA0',invert:0,pullup:0},hardware,cycleTime:.01,maxDuration:0,currentPrintTime:now},clock);
  await session.configure({oidCount:4,commands:config.commands,init:config.init,restart:config.restart,reservedMoves:1},signal);
  const pwm=new GenerationPWMOutput(config,session.dictionary,session.commandQueue(),session.commandQueue(),clock,c=>Number(c)/1e6);
  fan=new ScheduledCoolingFan(pwm,{maxPower:.8,kickStartTime:.05,minimumScheduleTime:.02});await fan.start(signal);fan.enqueue(now+.3,.4);await fan.flush(now+.4,signal);
  const writes=fw.outputs.filter(m=>m.name===(hardware?'queue_pwm_out_generation':'queue_digital_out_generation'));assert.equal(writes.length,2);assert.deepEqual(writes.map(m=>Number(m.parameters[hardware?'value':'on_ticks'])),hardware?[204,82]:[8000,3200]);assert(writes.every(m=>m.parameters.generation===1));
  assert.equal(Number(writes[0].parameters.clock),Number(BigInt.asUintN(32,clock(now+.3))));assert.equal(Number(writes[1].parameters.clock),Number(BigInt.asUintN(32,clock(now+.3+.05))));
  await fan.off(signal);assert.equal(pwm.status.generation,2);assert.equal(pwm.status.defaultConfirmed,true);assert.equal(fan.status.speed,0);
 }finally{await fan?.stop();await session.stop();await fw.close();}
});
