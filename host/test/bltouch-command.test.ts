import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BLTouchCommandQueue,planBLTouchCommand,type BLTouchCommand} from '../src/homing/bltouch-command.ts';
import {compilePWM,PWMOutput} from '../src/outputs/pwm.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal;
const clock=(frequency=1000000,base=0n)=>({clockAt:(t:number)=>base+BigInt(Math.trunc(t*frequency)),secondsToClock:(t:number)=>BigInt(Math.trunc(t*frequency)),printAt:(c:bigint)=>Number(c-base)/frequency});
test('BLTouch command PWM and action timing match original Python over clock and duration boundaries',()=>{
 const reference=JSON.parse(readFileSync(new URL('../contracts/bltouch-command-reference.json',import.meta.url),'utf8'));assert.equal(reference.cases.length,864);
 for(const row of reference.cases){const plan=planBLTouchCommand(clock(row.frequency,BigInt(row.base)),row.command,row.start,row.duration);assert.deepEqual([[plan.start,plan.duty],[plan.end,0]],row.writes);assert.equal(plan.next,row.next);assert.equal(plan.actionEnd,row.actionEnd);assert(plan.endClock>plan.startClock);}
});
test('command queue sends PWM off before publishing timing and separates successive commands',async()=>{
 const writes:number[][]=[],queue=new BLTouchCommandQueue({...clock(),async setPWM(time,duty){writes.push([time,duty]);},async stop(){assert.fail('unexpected stop');}});
 const first=await queue.send('pin_down',.2,signal(),.68);const second=await queue.send('touch_mode',.2,signal());assert.equal(second.start,first.next);assert.deepEqual(writes,[[first.start,first.duty],[first.end,0],[second.start,second.duty],[second.end,0]]);assert.equal(queue.status.actionEndTime,second.actionEnd);
});
test('off write failure poisons queue and awaits output stop without publishing timing',async()=>{
 let writes=0,stops=0;const queue=new BLTouchCommandQueue({...clock(),async setPWM(){if(++writes===2)throw Error('off write failed');},async stop(){stops++;}});
 await assert.rejects(queue.send('pin_down',.2,signal()),/off write/);assert.equal(stops,1);assert.equal(queue.status.nextCommandTime,0);assert(queue.status.failed);await assert.rejects(queue.send('pin_up',1,signal()),/stopped/);assert.equal(writes,2);
});
test('abort fences late command completion and rejects overlapping ownership',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();let writes=0,stops=0;
 const queue=new BLTouchCommandQueue({...clock(),async setPWM(){writes++;entered.resolve();await release.promise;},async stop(){stops++;release.resolve();}});
 const pending=queue.send('pin_down',.2,abort.signal);await entered.promise;await assert.rejects(queue.send('pin_up',1,signal()),/already active/);abort.abort(Error('cancel probe'));await assert.rejects(pending,/cancel probe/);assert.equal(writes,1);assert.equal(stops,1);assert.equal(queue.status.nextCommandTime,0);assert.equal(queue.status.busy,false);
});
test('invalid commands and unrepresentable clocks fail before writing',()=>{
 for(const command of ['unknown','toString','__proto__'])assert.throws(()=>planBLTouchCommand(clock(),command as BLTouchCommand,0));
 for(const start of [-1,NaN,Infinity,1e20])assert.throws(()=>planBLTouchCommand(clock(),'pin_down',start));
 for(const duration of [0,-1,NaN,Infinity])assert.throws(()=>planBLTouchCommand(clock(),'pin_down',0,duration));
 assert.throws(()=>planBLTouchCommand(clock(1000000,0x7fffffffffffffffn),'pin_down',0),/overflow/);
});
test('BLTouch deployment and PWM disable reach the native serial transport with 20ms cycle',async()=>{
 const fw=await serialFirmware(),session=new SerialSession(fw.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);const timing=clock(),now=Number(session.clock.sync.getClock(serialClock.now()))/1e6;
  const config=compilePWM(chip,session.dictionary,{oid:3,pin:pins.lookup('PA0'),cycleTime:.020,maxDuration:0,currentPrintTime:now},timing.clockAt);
  await session.configure({oidCount:4,commands:config.commands,restart:config.restart,init:config.init,reservedMoves:config.reservedMoves},signal());
  const transport=session.commandQueue(),output=new PWMOutput(config,session.dictionary,transport,timing.clockAt,timing.printAt),queue=new BLTouchCommandQueue({...timing,setPWM:(...args)=>output.setPWM(...args),stop:cause=>transport.stop(cause)});
  const plan=await queue.send('pin_down',now+.3,signal(),.68),sent=fw.outputs.filter(o=>o.name==='queue_digital_out').slice(-2);
  assert.equal(sent.length,2);assert.equal(sent[0].parameters.on_ticks,650);assert.equal(sent[1].parameters.on_ticks,0);assert.equal(sent[0].parameters.clock,Number(BigInt.asUintN(32,plan.startClock)));assert.equal(sent[1].parameters.clock,Number(BigInt.asUintN(32,timing.clockAt(plan.end))));assert(fw.outputs.some(o=>o.name==='set_digital_out_pwm_cycle'&&o.parameters.cycle_ticks===20000));
 }finally{await session.stop();await fw.close();}
});
