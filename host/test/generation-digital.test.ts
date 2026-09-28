import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GenerationDigitalOutput,DigitalGenerationSuperseded} from '../src/outputs/generation-digital.ts';
import {compileDigital} from '../src/outputs/digital.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import type {TimedCommandQueue} from '../src/protocol/serial-session.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {stepperBatchFixture} from './helpers/configured-steppers.ts';
const signal=()=>new AbortController().signal;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('native serial control reset overtakes delayed digital writes without PWM setup',async()=>{
 const {serialFirmware}=await import('./helpers/serial-firmware.ts');
 const {SerialSession}=await import('../src/protocol/serial-session.ts');
 const {serialClock}=await import('../src/protocol/serial-queue.ts');
 const firmware=await serialFirmware(),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6));
  const now=Number(session.clock.sync.getClock(serialClock.now()))/1e6;
  const plan=compileDigital(chip,session.dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},maxDuration:0});
  await session.configure({oidCount:4,commands:[plan.config],restart:[plan.restart],reservedMoves:plan.reservedMoves},signal());
  const output=new GenerationDigitalOutput(plan,session.dictionary,session.commandQueue(),session.commandQueue(),clock);
  await output.reset(signal());await output.setDigital(now+.8,true,signal());
  const old=output.setDigital(now+.9,false,signal()),rejected=assert.rejects(old,DigitalGenerationSuperseded);
  await output.reset(signal());await rejected;
  const events=firmware.outputs;
  const reset=events.findIndex(e=>e.name==='reset_digital_out_generation'&&e.parameters.generation===2);
  const stale=events.findIndex(e=>e.name==='queue_digital_out_generation'&&e.parameters.generation===1&&e.parameters.on_ticks===0);
  assert.ok(reset>=0&&stale>reset);
  assert.ok(!events.some(e=>e.name==='set_digital_out_pwm_cycle'));
  await output.setDigital(now+1.1,true,signal());
  assert.equal(events.at(-1)?.parameters.generation,2);await output.stop();
 }finally{await session.stop();await firmware.close();}
});
test('digital reset drains stale writes and preserves binary inversion across clock wrap',async()=>{
 const f=setup(),clock=new PrintClockTimeline({offset:0,frequency:1000});
 const output=GenerationDigitalOutput.withClock(f.plan,f.dictionary,f.data.queue,f.control.queue,clock);
 assert.deepEqual(output.configuration,{initialValue:true,defaultValue:false});
 await assert.rejects(output.setDigital(1,true,signal()),/not ready/);
 const initial=output.reset(signal());f.control.calls[0].resolve();await initial;
 const time=Number(0x100000001n)/1000;
 const old=output.setDigital(time,true,signal()),rejected=assert.rejects(old,DigitalGenerationSuperseded);
 assert.equal(f.data.calls[0].req,0x100000001n);
 assert.equal(f.data.calls[0].message.parameters.clock,1);
 assert.equal(f.data.calls[0].message.parameters.on_ticks,0);
 assert.equal(f.data.calls[0].message.parameters.generation,1);
 const reset=output.reset(signal());f.control.calls[1].resolve();await flush();
 assert.equal(output.status.phase,'resetting');
 assert.equal(output.status.defaultConfirmed,true);
 f.data.calls[0].resolve();await rejected;await reset;
 assert.equal(clock.status.reservedThrough,0x100000001n);
 const next=output.setDigital(time+1,false,signal());
 assert.equal(f.data.calls[1].min,0n);
 assert.equal(f.data.calls[1].message.parameters.on_ticks,1);
 assert.equal(f.data.calls[1].message.parameters.generation,2);
 f.data.calls[1].resolve();await next;await output.stop();
});
function setup(){
 const f=stepperBatchFixture(),mcu=f.mcus.get('mcu')!,dictionary=mcu.dictionary;
 const plan=compileDigital(mcu.chip,dictionary,{oid:3,pin:f.pins.parse('!PA2',{canInvert:true}),start:true,shutdown:false,maxDuration:0});
 const make=()=>{
  const calls:{message:ReturnType<MessageDictionary['parseFrame']>[number];min:bigint;req:bigint;resolve:()=>void;reject:(cause:unknown)=>void}[]=[];let stops=0;
  const queue:TimedCommandQueue={send(payload,min,req){const deferred=Promise.withResolvers<void>();calls.push({message:dictionary.parseFrame(encodeFrame(0,payload))[0],min,req,...deferred});return deferred.promise;},async stop(cause){stops++;for(const call of calls)call.reject(cause);}};
  return {queue,calls,get stops(){return stops;}};
 };
 const data=make(),control=make(),output=new GenerationDigitalOutput(plan,dictionary,data.queue,control.queue,t=>BigInt(Math.trunc(t*1000)));
 return {plan,dictionary,data,control,output};
}
test('reset and data transport failures permanently fence Digital and stop both queues',async()=>{
 for(const failing of ['reset','data']){
  const f=setup(),error=new Error('wire failed');
  const reset=f.output.reset(signal());
  if(failing==='reset'){f.control.calls[0].reject(error);await assert.rejects(reset,error);}else{
   f.control.calls[0].resolve();await reset;const write=f.output.setDigital(2,true,signal());f.data.calls[0].reject(error);await assert.rejects(write,error);
  }
  assert.equal(f.output.status.phase,'failed');assert.equal(f.output.status.fault,error);assert.equal(f.data.stops,1);assert.equal(f.control.stops,1);await assert.rejects(f.output.reset(signal()),/stopped/);
 }
});
test('cancellation by a joined reset caller stops the device even after reset ACK',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 const old=f.output.setDigital(2,true,signal());const oldResult=old.catch(error=>error);
 const reset=f.output.reset(signal()),controller=new AbortController(),joined=f.output.reset(controller.signal);
 const results=Promise.allSettled([reset,joined]);f.control.calls[1].resolve();await flush();controller.abort(new Error('cancelled'));
 assert.ok((await results).every(result=>result.status==='rejected'));await oldResult;assert.equal(f.output.status.phase,'failed');assert.equal(f.data.stops,1);
});
test('pending writes are bounded and shutdown failures remain observable',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 f.control.queue.stop=async()=>{throw new Error('safety failed');};
 const writes=Array.from({length:33},(_,i)=>f.output.setDigital(2+i*.001,true,signal()).catch(error=>error));await Promise.all(writes);
 assert.equal(f.data.calls.length,32);assert.equal(f.output.status.phase,'failed');assert.match(String(f.output.status.stopError),/safety stop failed/);
});
test('independent control queue and firmware capability are mandatory before any output',()=>{
 const f=setup();assert.throws(()=>new GenerationDigitalOutput(f.plan,f.dictionary,f.data.queue,f.data.queue,()=>0n),/independent/);
 const empty=new MessageDictionary();empty.identify(Buffer.from(JSON.stringify({commands:{},responses:{},config:{}})),false);
 assert.throws(()=>new GenerationDigitalOutput(f.plan,empty,f.data.queue,f.control.queue,()=>0n));assert.equal(f.data.calls.length,0);assert.equal(f.control.calls.length,0);
});
test('stop initiates both safety queues synchronously and awaits accepted data after safety ACK',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 const write=f.output.setDigital(2,true,signal()),rejected=assert.rejects(write,/cancel/),events:string[]=[],reason=new Error('cancel');let reentrant:Promise<void>|undefined;
 f.data.queue.stop=()=>{events.push('data');reentrant=f.output.stop(reason);return Promise.resolve();};f.control.queue.stop=async()=>{events.push('control');};
 let finished=false;const stopping=f.output.stop(reason);void stopping.then(()=>{finished=true;});assert.deepEqual(events,['data','control']);assert.equal(reentrant,stopping);await flush();assert.equal(finished,false);assert.equal(f.output.status.pendingWrites,1);
 f.data.calls[0].resolve();await stopping;await rejected;assert.equal(f.output.status.pendingWrites,0);assert.equal(f.output.status.phase,'failed');
});
test('stop waits for late reset transport settlement without waiting cyclically on reset',async()=>{
 for(const success of [true,false]){
  const f=setup(),reset=f.output.reset(signal()),rejected=assert.rejects(reset),events:string[]=[];
  f.data.queue.stop=async()=>{events.push('data');};f.control.queue.stop=async()=>{events.push('control');};
  let finished=false;const stopping=f.output.stop(new Error('cancel'));void stopping.then(()=>{finished=true;});assert.deepEqual(events,['data','control']);await flush();assert.equal(finished,false);
  if(success)f.control.calls[0].resolve();else f.control.calls[0].reject(new Error('late reset failure'));
  await stopping;await rejected;assert.equal(f.output.status.phase,'failed');assert.equal(f.output.status.defaultConfirmed,false);
 }
});
test('synchronous safety failure still starts the other queue and retains the send settlement fence',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 const write=f.output.setDigital(2,true,signal()),rejected=assert.rejects(write),events:string[]=[];
 f.data.queue.stop=()=>{events.push('data');throw new Error('safety failed');};f.control.queue.stop=async()=>{events.push('control');};
 let finished=false;const stopping=f.output.stop();void stopping.catch(()=>{finished=true;});const stopped=assert.rejects(stopping,/safety stop failed/);assert.deepEqual(events,['data','control']);await flush();assert.equal(finished,false);
 f.data.calls[0].reject(new Error('late send failed'));await stopped;await rejected;assert.match(String(f.output.status.stopError),/safety stop failed/);
});
