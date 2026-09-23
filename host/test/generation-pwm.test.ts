import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GenerationPWMOutput,PWMGenerationSuperseded} from '../src/outputs/generation-pwm.ts';
import {compilePWM} from '../src/outputs/pwm.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import type {TimedCommandQueue} from '../src/protocol/serial-session.ts';
const signal=()=>new AbortController().signal;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(hardware=false){
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'set_digital_out_pwm_cycle oid=%c cycle_ticks=%u':26,'config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u':21,'queue_digital_out oid=%c clock=%u on_ticks=%u':23,'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':30,'reset_pwm_out_generation oid=%c generation=%u':31,'queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u':32,'reset_digital_out_generation oid=%c generation=%u':33},responses:{},config:{CLOCK_FREQ:1000,PWM_MAX:255}})),false);
 const chip={},plan=compilePWM(chip,dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:1,pullup:0},hardware,currentPrintTime:1},t=>BigInt(Math.trunc(t*1000)));
 const make=()=>{
  const calls:{message:ReturnType<MessageDictionary['parseFrame']>[number];min:bigint;req:bigint;resolve:()=>void;reject:(cause:unknown)=>void}[]=[];let stops=0;
  const queue:TimedCommandQueue={send(payload,min,req){const deferred=Promise.withResolvers<void>();calls.push({message:dictionary.parseFrame(encodeFrame(0,payload))[0],min,req,...deferred});return deferred.promise;},async stop(cause){stops++;for(const call of calls)call.reject(cause);}};
  return {queue,calls,get stops(){return stops;}};
 };
 const data=make(),control=make(),output=new GenerationPWMOutput(plan,dictionary,data.queue,control.queue,t=>BigInt(Math.trunc(t*1000)),c=>Number(c)/1000);
 return {plan,dictionary,data,control,output};
}
for(const hardware of [false,true])test(`${hardware?'hardware':'software'} PWM reset confirms safe default, drains old writes and advances generation`,async()=>{
 const f=setup(hardware);assert.deepEqual(f.output.configuration,{cycleTime:.1,maximumDuration:2,initialPower:0,defaultPower:0});await assert.rejects(f.output.setPWM(2,.5,signal()),/not ready/);
 const initial=f.output.reset(signal());assert.equal(f.control.calls[0].min,0n);assert.equal(f.control.calls[0].req,0n);f.control.calls[0].resolve();await initial;
 assert.equal(f.output.status.defaultConfirmed,true);
 const old=f.output.setPWM(2,.25,signal()),oldRejected=assert.rejects(old,PWMGenerationSuperseded);
 assert.equal(f.output.status.defaultConfirmed,false);assert.equal(f.data.calls[0].message.parameters.generation,1);
 assert.equal(f.data.calls[0].message.parameters[hardware?'value':'on_ticks'],hardware?191:75);
 const reset=f.output.reset(signal()),duplicate=f.output.reset(signal());assert.equal(f.control.calls.length,2);
 f.control.calls[1].resolve();await flush();assert.equal(f.output.status.defaultConfirmed,true);assert.equal(f.output.status.phase,'resetting');
 await assert.rejects(f.output.setPWM(1.5,.5,signal()),/not ready/);
 f.data.calls[0].resolve();await oldRejected;await Promise.all([reset,duplicate]);assert.equal(f.data.stops,0);assert.equal(f.output.status.phase,'ready');
 const next=f.output.setPWM(1.5,.5,signal());assert.equal(f.data.calls[1].min,0n);assert.equal(f.data.calls[1].message.parameters.generation,2);f.data.calls[1].resolve();await next;
 await f.output.stop();assert.equal(f.data.stops,1);assert.equal(f.control.stops,1);
});
test('reset and data transport failures permanently fence PWM and stop both queues',async()=>{
 for(const failing of ['reset','data']){
  const f=setup(),error=new Error('wire failed');
  const reset=f.output.reset(signal());
  if(failing==='reset'){f.control.calls[0].reject(error);await assert.rejects(reset,error);}else{
   f.control.calls[0].resolve();await reset;const write=f.output.setPWM(2,.5,signal());f.data.calls[0].reject(error);await assert.rejects(write,error);
  }
  assert.equal(f.output.status.phase,'failed');assert.equal(f.output.status.fault,error);assert.equal(f.data.stops,1);assert.equal(f.control.stops,1);await assert.rejects(f.output.reset(signal()),/stopped/);
 }
});
test('cancellation by a joined reset caller stops the device even after reset ACK',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 const old=f.output.setPWM(2,.5,signal());const oldResult=old.catch(error=>error);
 const reset=f.output.reset(signal()),controller=new AbortController(),joined=f.output.reset(controller.signal);
 const results=Promise.allSettled([reset,joined]);f.control.calls[1].resolve();await flush();controller.abort(new Error('cancelled'));
 assert.ok((await results).every(result=>result.status==='rejected'));await oldResult;assert.equal(f.output.status.phase,'failed');assert.equal(f.data.stops,1);
});
test('pending writes are bounded and shutdown failures remain observable',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 f.control.queue.stop=async()=>{throw new Error('safety failed');};
 const writes=Array.from({length:33},(_,i)=>f.output.setPWM(2+i*.001,.5,signal()).catch(error=>error));await Promise.all(writes);
 assert.equal(f.data.calls.length,32);assert.equal(f.output.status.phase,'failed');assert.match(String(f.output.status.stopError),/safety stop failed/);
});
test('independent control queue and firmware capability are mandatory before any output',()=>{
 const f=setup();assert.throws(()=>new GenerationPWMOutput(f.plan,f.dictionary,f.data.queue,f.data.queue,()=>0n,()=>0),/independent/);
 const empty=new MessageDictionary();empty.identify(Buffer.from(JSON.stringify({commands:{},responses:{},config:{}})),false);
 assert.throws(()=>new GenerationPWMOutput(f.plan,empty,f.data.queue,f.control.queue,()=>0n,()=>0));assert.equal(f.data.calls.length,0);assert.equal(f.control.calls.length,0);
});
test('stop initiates both safety queues synchronously and awaits accepted data after safety ACK',async()=>{
 const f=setup(),initial=f.output.reset(signal());f.control.calls[0].resolve();await initial;
 const write=f.output.setPWM(2,.5,signal()),rejected=assert.rejects(write,/cancel/),events:string[]=[],reason=new Error('cancel');let reentrant:Promise<void>|undefined;
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
 const write=f.output.setPWM(2,.5,signal()),rejected=assert.rejects(write),events:string[]=[];
 f.data.queue.stop=()=>{events.push('data');throw new Error('safety failed');};f.control.queue.stop=async()=>{events.push('control');};
 let finished=false;const stopping=f.output.stop();void stopping.catch(()=>{finished=true;});const stopped=assert.rejects(stopping,/safety stop failed/);assert.deepEqual(events,['data','control']);await flush();assert.equal(finished,false);
 f.data.calls[0].reject(new Error('late send failed'));await stopped;await rejected;assert.match(String(f.output.status.stopError),/safety stop failed/);
});
test('native serial control FIFO resets while stale-generation PWM remains delayed',async()=>{
 const {serialFirmware}=await import('./helpers/serial-firmware.ts');
 const {SerialSession}=await import('../src/protocol/serial-session.ts');
 const {serialClock}=await import('../src/protocol/serial-queue.ts');
 const firmware=await serialFirmware(),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6)),print=(clock:bigint)=>Number(clock)/1e6;
  const now=print(session.clock.sync.getClock(serialClock.now()));
  const plan=compilePWM(chip,session.dictionary,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},currentPrintTime:now},clock);
  await session.configure({oidCount:4,commands:plan.commands,init:plan.init,restart:plan.restart,reservedMoves:plan.reservedMoves},signal());
  const output=new GenerationPWMOutput(plan,session.dictionary,session.commandQueue(),session.commandQueue(),clock,print);await output.reset(signal());
  await output.setPWM(now+.8,.5,signal());
  const old=output.setPWM(now+.9,.6,signal()),oldResult=assert.rejects(old,PWMGenerationSuperseded);
  const reset=output.reset(signal());await reset;await oldResult;
  const events=firmware.outputs.filter(event=>event.name.includes('_generation'));
  const resetIndex=events.findIndex(event=>event.name==='reset_digital_out_generation'&&event.parameters.generation===2);
  const staleIndex=events.findIndex(event=>event.name==='queue_digital_out_generation'&&event.parameters.on_ticks===60000);
  assert.ok(resetIndex>=0&&staleIndex>resetIndex);assert.equal(output.status.phase,'ready');
  await output.setPWM(now+1.1,.25,signal());assert.equal(firmware.outputs.at(-1)?.parameters.generation,2);await output.stop();
 }finally{await session.stop();await firmware.close();}
});
test('publishing ready and clearing reset ownership is atomic against a microtask caller',async()=>{
 const f=setup(),first=f.output.reset(signal());
 const observed=new Promise<{write:Promise<unknown>;reset:Promise<void>}>((resolve,reject)=>{
  let polls=0;const poll=()=>{
   if(++polls>100){reject(new Error('ready was never published'));return;}
   if(f.output.status.phase!=='ready'){queueMicrotask(poll);return;}
   const write=f.output.setPWM(2,.5,signal()).catch(error=>error);
   resolve({write,reset:f.output.reset(signal())});
  };queueMicrotask(poll);
 });
 f.control.calls[0].resolve();const next=await observed;await first;
 assert.equal(f.control.calls.length,2);f.control.calls[1].resolve();f.data.calls[0].resolve();await next.reset;assert.ok(await next.write instanceof PWMGenerationSuperseded);await f.output.stop();
});
