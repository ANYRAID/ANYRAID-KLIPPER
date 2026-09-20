import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncHeaterRuntime,type ConfirmedHeaterOutput} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let now=1,tick=()=>{},stops=0,cancelled=0;
 const resets:ReturnType<typeof Promise.withResolvers<void>>[]=[],writes:(ReturnType<typeof Promise.withResolvers<void>>&{time:number;power:number})[]=[],stopped=Promise.withResolvers<void>();
 const output:ConfirmedHeaterOutput={configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},reset(){const job=Promise.withResolvers<void>();resets.push(job);return job.promise;},setPWM(time,power){const job=Promise.withResolvers<void>();writes.push({...job,time,power});return job.promise;},stop(cause){stops++;for(const reset of resets)reset.reject(cause);for(const write of writes)write.reject(cause);return stopped.promise;}};
 const runtime=new AsyncHeaterRuntime(config,new BangBangControl(1),output,()=>({system:now,print:now}),{},callback=>{tick=callback;return ()=>{cancelled++;};});
 return {runtime,output,resets,writes,stopped,get stops(){return stops;},get cancelled(){return cancelled;},advance(time:number){now=time;tick();}};
}
test('async heater start and zero target cannot complete before reset confirmation',async()=>{
 const f=fixture(),starting=f.runtime.start();assert.equal(f.runtime.status.phase,'starting');await assert.rejects(f.runtime.setTarget(200),/not active/);
 f.resets[0].resolve();await starting;f.runtime.sample(1,200);await f.runtime.setTarget(220);f.runtime.sample(1.1,200);assert.equal(f.writes.length,1);f.writes[0].resolve();await flush();
 const off=f.runtime.setTarget(0);assert.equal(f.runtime.status.target,0);assert.equal(f.runtime.status.phase,'resetting');await assert.rejects(f.runtime.setTarget(200),/not active/);
 f.runtime.sample(1.2,200);assert.equal(f.writes.length,1);assert.equal(f.runtime.canExtrude(),false);
 f.resets[1].resolve();await off;assert.equal(f.runtime.status.phase,'active');await f.runtime.setTarget(220);f.runtime.sample(1.3,200);assert.equal(f.writes.length,2);
 const stopping=f.runtime.shutdown();assert.equal(f.runtime.status.phase,'stopping');assert.equal(f.runtime.status.outputStopConfirmed,false);f.stopped.resolve();await stopping;assert.equal(f.runtime.status.outputStopConfirmed,true);assert.equal(f.runtime.status.phase,'stopped');
});
test('write rejection trips synchronous admission fence and shutdown remains awaitable',async()=>{
 const f=fixture(),starting=f.runtime.start();f.resets[0].resolve();await starting;f.runtime.sample(1,25);await f.runtime.setTarget(200);f.runtime.sample(1.1,25);
 const error=new Error('UART failed');f.writes[0].reject(error);await flush();assert.equal(f.runtime.status.phase,'stopping');assert.equal(f.runtime.status.cause,error);assert.equal(f.runtime.status.target,0);assert.equal(f.stops,1);
 await assert.rejects(f.runtime.setTarget(200),/active|UART/);const stopping=f.runtime.shutdown();f.stopped.resolve();await stopping;assert.equal(f.cancelled,1);
});
test('independent watchdog trips asynchronous device stop without another ADC report',async()=>{
 const f=fixture(),starting=f.runtime.start();f.resets[0].resolve();await starting;f.runtime.sample(1,25);f.advance(7);assert.equal(f.runtime.status.phase,'stopping');assert.match(String(f.runtime.status.cause),/timer stalled/);
 f.stopped.resolve();await f.runtime.shutdown();assert.equal(f.runtime.status.phase,'stopped');
});
test('shutdown during startup rejects start and never arms control after late reset ACK',async()=>{
 const f=fixture(),starting=f.runtime.start(),startResult=assert.rejects(starting,/cancelled/),stop=f.runtime.shutdown(new Error('cancelled'));
 f.resets[0].resolve();f.stopped.resolve();await stop;await startResult;assert.equal(f.runtime.status.started,false);assert.equal(f.runtime.status.phase,'stopped');assert.equal(f.cancelled,0);
});
test('output stop and observer failures are retained without falsely confirming device stop',async()=>{
 const f=fixture();f.runtime.subscribeShutdown(()=>{throw new Error('observer failed');});let reached=false;f.runtime.subscribeShutdown(()=>{reached=true;});
 const stop=f.runtime.shutdown(new Error('original'));f.stopped.reject(new Error('safety failed'));await assert.rejects(stop,AggregateError);
 assert.equal(reached,true);assert.equal(f.runtime.status.outputStopConfirmed,false);assert.equal(f.runtime.status.phase,'failed');assert.equal(f.runtime.status.shutdownErrors.length,2);assert.match(String(f.runtime.status.cause),/original/);
});
test('unsafe configured default, watchdog or cycle are rejected before IO',()=>{
 const f=fixture();for(const override of [{defaultPower:1},{maximumDuration:0},{maximumDuration:2},{cycleTime:.4}])assert.throws(()=>new AsyncHeaterRuntime(config,new BangBangControl(1),{...f.output,configuration:{...f.output.configuration,...override}},()=>({system:1,print:1})),/requires/);
 assert.equal(f.resets.length,0);assert.equal(f.stops,0);
});
test('caller cancellation after output ACK still prevents startup becoming active',async()=>{
 const f=fixture(),controller=new AbortController(),starting=f.runtime.start(controller.signal),result=assert.rejects(starting,/cancelled/);
 f.resets[0].resolve();controller.abort(new Error('cancelled'));await flush();assert.equal(f.runtime.status.phase,'stopping');f.stopped.resolve();await result;assert.equal(f.runtime.status.started,false);
});
test('bounded pending PWM requests stop admission synchronously on overload',async()=>{
 const f=fixture(),starting=f.runtime.start();f.resets[0].resolve();await starting;f.runtime.sample(1,25);await f.runtime.setTarget(200);
 for(let i=1;i<=32;i++)f.runtime.sample(1+i*.01,i%2?25:300);
 assert.throws(()=>f.runtime.sample(1.33,25),/pending output limit/);assert.equal(f.runtime.status.phase,'stopping');assert.equal(f.writes.length,32);
 f.stopped.resolve();await f.runtime.shutdown();assert.equal(f.runtime.status.pendingWrites,0);
});
test('native serial ADC drives acknowledged heater PWM and a sensor fault stops the session',async()=>{
 const {serialFirmware}=await import('./helpers/serial-firmware.ts');
 const {SerialSession}=await import('../src/protocol/serial-session.ts');
 const {serialClock}=await import('../src/protocol/serial-queue.ts');
 const {compilePWM}=await import('../src/outputs/pwm.ts');
 const {GenerationPWMOutput}=await import('../src/outputs/generation-pwm.ts');
 const {SerialADCTemperature}=await import('../src/thermal/serial-adc.ts');
 const {readHeaterConfiguration,createConfiguredAsyncHeater}=await import('../src/thermal/heater-config.ts');
 const {ConfigurationReader}=await import('../src/moonraker/config-reader.ts');
 const {ConfigurationSource}=await import('../src/moonraker/config-source.ts');
 const reader=new ConfigurationReader(new ConfigurationSource('/heater.cfg',{extruder:{sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'watermark'}},[]),null);
 const parsed=readHeaterConfiguration(reader,'extruder'),requirements=parsed.outputRequirements;
 const firmware=await serialFirmware();let deviceStops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){deviceStops++;}}),signal=new AbortController().signal;
 let runtime:AsyncHeaterRuntime|undefined;
 try{
  await session.initialize(signal);const chip={},clock=(t:number)=>BigInt(Math.trunc(t*1e6)),print=(clock:bigint)=>Number(clock)/1e6;
  const now=()=>print(session.clock.sync.getClock(serialClock.now())),pin=(name:string)=>({chip,chipName:'mcu',pin:name,invert:0 as const,pullup:0 as const});
  const plan=compilePWM(chip,session.dictionary,{oid:3,pin:pin('PA0'),...requirements,maxDuration:requirements.maximumDuration,currentPrintTime:now()},clock),converter=parsed.converter;
  const sensor=new SerialADCTemperature(session,chip,{oid:4,pin:pin('PA1'),minimum:0,maximum:300,currentPrintTime:now()},converter,clock,print,{sample:(time,temp)=>runtime!.sample(time,temp),shutdown:reason=>{void runtime?.shutdown(reason).catch(()=>{});}});
  await session.configure({oidCount:5,commands:[...plan.commands,...sensor.plan.commands],init:[...plan.init,...sensor.plan.init],restart:plan.restart,reservedMoves:plan.reservedMoves},signal);
  const output=new GenerationPWMOutput(plan,session.dictionary,session.commandQueue(),session.commandQueue(),clock,print);
  runtime=createConfiguredAsyncHeater(reader,'extruder',()=>output,()=>({system:serialClock.now(),print:now()}),()=>()=>{}).runtime;
  await runtime.start(signal);sensor.activate();
  const emit=(temperature:number)=>{const raw=Math.round(converter.adc(temperature)*32760),next=clock(now()+.3-.008);firmware.emit('analog_in_state',{oid:4,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});};
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('serial heater condition timed out');await new Promise(resolve=>setTimeout(resolve,2));}};
  emit(25);await until(()=>runtime!.status.received);await runtime.setTarget(200,signal);emit(26);
  await until(()=>firmware.outputs.some(event=>event.name==='queue_digital_out_generation'&&event.parameters.on_ticks===100000));
  await runtime.setTarget(0,signal);assert.equal(output.status.defaultConfirmed,true);assert.equal(runtime.status.phase,'active');
  assert.ok(firmware.outputs.some(event=>event.name==='reset_digital_out_generation'&&event.parameters.generation===2));
  emit(350);await until(()=>runtime!.status.stopped);await runtime.shutdown();assert.equal(runtime.status.outputStopConfirmed,true);assert.equal(deviceStops,1);assert.equal(session.status.state,'closed');
 }finally{await runtime?.shutdown().catch(()=>{});await session.stop().catch(()=>{});await firmware.close();}
});
test('reentrant stop during output submission still waits for the accepted write',async()=>{
 const f=fixture(),starting=f.runtime.start();f.resets[0].resolve();await starting;f.runtime.sample(1,25);await f.runtime.setTarget(200);
 const accepted=Promise.withResolvers<void>();let stop:Promise<void>|undefined,completed=false;
 f.output.setPWM=()=>{stop=f.runtime.shutdown();void stop.then(()=>{completed=true;});return accepted.promise;};
 f.runtime.sample(1.1,25);f.stopped.resolve();await flush();assert.equal(completed,false);assert.equal(f.runtime.status.pendingWrites,1);
 accepted.resolve();await stop;assert.equal(completed,true);assert.equal(f.runtime.status.pendingWrites,0);
});
test('reentrant stop while creating protection timer cancels the newly returned timer',async()=>{
 const f=fixture();let cancelled=0;const runtime=new AsyncHeaterRuntime(config,new BangBangControl(1),f.output,()=>({system:1,print:1}),{},()=>{void runtime.shutdown();return ()=>{cancelled++;};});
 const start=runtime.start(),result=assert.rejects(start,/stopped/);f.resets[0].resolve();f.stopped.resolve();await result;assert.equal(cancelled,1);assert.equal(runtime.status.phase,'stopped');
});
