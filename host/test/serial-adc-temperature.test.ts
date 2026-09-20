import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialADCTemperature,type SensorTimer} from '../src/thermal/serial-adc.ts';
import {Thermistor} from '../src/thermal/thermistor.ts';
const format='analog_in_state oid=%c next_clock=%u values=%*s';
const signal=()=>new AbortController().signal;
async function until(check:()=>boolean){const end=Date.now()+1500;while(!check()){if(Date.now()>end)throw new Error('Condition timed out');await delay(2);}}
async function pair(){const fw=await serialFirmware();let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});await s.initialize(signal());return {fw,s,get stops(){return stops;},async close(){await s.stop().catch(()=>{});await fw.close();}};}
test('response subscriptions are exclusive, isolate OIDs, detach and close all consumers despite cleanup failure',async()=>{
 const p=await pair();let a=0,b=0,closed=0;try{
  const pending=p.s.query(p.s.dictionary.encode('stepper_get_position',{oid:5}),'stepper_position',signal(),{oid:5});assert.throws(()=>p.s.subscribeResponse('stepper_position oid=%c pos=%i',5,{receive(){},closed(){}}),/idle route/);await pending;
  const detach=p.s.subscribeResponse(format,3,{receive(){a++;},closed(){closed++;throw new Error('cleanup failed');}});
  p.s.subscribeResponse(format,4,{receive(){b++;},closed(){closed++;}});
  assert.throws(()=>p.s.subscribeResponse(format,3,{receive(){},closed(){}}),/duplicate/);
  await assert.rejects(p.s.query(new Uint8Array(),'analog_in_state',signal(),{oid:3}),/subscribed/);
  p.fw.emit('analog_in_state',{oid:3,next_clock:1000000,values:Buffer.from([0,0])});await until(()=>a===1);assert.equal(b,0);
  detach();const stop=p.s.subscribeResponse(format,3,{receive(){a++;},closed(){closed++;throw new Error('cleanup failed');}});detach();
  p.fw.emit('analog_in_state',{oid:4,next_clock:1000000,values:Buffer.from([0,0])});await until(()=>b===1);
  await assert.rejects(p.s.stop(new Error('wire closed')),/cleanup failed/);assert.equal(closed,2);assert.equal(p.stops,1);stop();
 }finally{await p.close();}
});
function wiring(p:Awaited<ReturnType<typeof pair>>,oid=3){
 const chip={},converter=new Thermistor(4700,0,{point:[25,100000],beta:3950}),readings:[number,number][]=[],faults:string[]=[];
 let offset=0,tick:(()=>void)|undefined,cancelled=0;
 const timer:SensorTimer={now:()=>serialClock.now()+offset,schedule(cb){tick=cb;return ()=>{cancelled++;tick=undefined;};}};
 const print=(clock:bigint)=>Number(clock)/1e6,now=print(p.s.clock.sync.getClock(serialClock.now()));
 const sensor=new SerialADCTemperature(p.s,chip,{oid,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},minimum:0,maximum:300,currentPrintTime:now},converter,t=>BigInt(Math.trunc(t*1e6)),print,{sample(t,v){readings.push([t,v]);},shutdown(reason){faults.push(reason);}},timer);
 return {sensor,readings,faults,converter,advance(seconds:number){offset+=seconds;tick?.();},get cancelled(){return cancelled;},emit(temp:number,delta=0){const raw=Math.round(converter.adc(temp)*32760),next=BigInt.asUintN(32,p.s.clock.sync.getClock(serialClock.now())+BigInt(Math.trunc((.3-.008+delta)*1e6)));p.fw.emit('analog_in_state',{oid,next_clock:Number(next),values:Buffer.from([raw&255,raw>>8])});}};
}
test('temperature wiring buffers pre-activation reports and converts the latest calibrated ADC reading',async()=>{
 const p=await pair();try{const w=wiring(p);await p.s.configure({oidCount:4,commands:w.sensor.plan.commands,init:w.sensor.plan.init},signal());w.emit(200);await until(()=>w.sensor.status.lastSample!==undefined);assert.equal(w.readings.length,0);w.sensor.activate();assert.equal(w.readings.length,1);assert.ok(Math.abs(w.readings[0][1]-200)<.02);w.emit(150,.3);await until(()=>w.readings.length===2);assert.ok(Math.abs(w.readings[1][1]-150)<.02);await p.s.stop(new Error('disconnected'));assert.equal(w.faults.length,1);assert.equal(w.cancelled,1);assert.equal(w.sensor.status.closed,true);assert.throws(()=>w.sensor.activate(),/restart/);
 }finally{await p.close();}
});
for(const received of [false,true])test(`temperature watchdog stops the MCU on ${received?'stale':'missing initial'} reports`,async()=>{
 const p=await pair();try{const w=wiring(p);await p.s.configure({oidCount:4,commands:w.sensor.plan.commands,init:w.sensor.plan.init},signal());w.sensor.activate();if(received){w.emit(180);await until(()=>w.readings.length===1);}w.advance(7.1);await until(()=>p.stops===1);assert.equal(w.sensor.status.closed,true);assert.equal(w.faults.length,1);assert.equal(w.cancelled,1);
 }finally{await p.close();}
});
test('future reports cannot extend sensor freshness and fault all subscriptions on the MCU',async()=>{
 const p=await pair();try{const a=wiring(p,3),b=wiring(p,4);await p.s.configure({oidCount:5,commands:[...a.sensor.plan.commands,...b.sensor.plan.commands],init:[...a.sensor.plan.init,...b.sensor.plan.init]},signal());a.sensor.activate();b.sensor.activate();a.emit(180,2);await until(()=>p.stops===1);assert.equal(a.readings.length,0);assert.equal(a.faults.length,1);assert.equal(b.faults.length,1);assert.equal(b.sensor.status.closed,true);
 }finally{await p.close();}
});
test('sensor activation before firmware configuration fails closed',async()=>{const p=await pair();try{const w=wiring(p);assert.throws(()=>w.sensor.activate(),/not configured/);await until(()=>p.stops===1);assert.equal(w.faults.length,1);}finally{await p.close();}});
test('consumer failure stops the MCU even when temperature cleanup also fails',async()=>{
 const p=await pair();try{const chip={},converter=new Thermistor(4700,0,{point:[25,100000],beta:3950}),now=Number(p.s.clock.sync.getClock(serialClock.now()))/1e6;
 const sensor=new SerialADCTemperature(p.s,chip,{oid:3,pin:{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:0},minimum:0,maximum:300,currentPrintTime:now},converter,t=>BigInt(Math.trunc(t*1e6)),n=>Number(n)/1e6,{sample(){throw new Error('consumer failed');},shutdown(){throw new Error('cleanup failed');}});
 await p.s.configure({oidCount:4,commands:sensor.plan.commands,init:sensor.plan.init},signal());sensor.activate();const raw=Math.round(converter.adc(180)*32760),next=p.s.clock.sync.getClock(serialClock.now())+292000n;p.fw.emit('analog_in_state',{oid:3,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});await until(()=>p.stops===1);assert.match(String(sensor.status.fault),/consumer failed/);assert.ok(sensor.status.stopError);await assert.rejects(sensor.stop(),/consumer shutdown failed/);
 }finally{await p.close();}
});
test('native ACK may precede a query response without closing a subscribed sensor session',async()=>{
 const p=await pair();try{const w=wiring(p);await p.s.configure({oidCount:4,commands:w.sensor.plan.commands,init:w.sensor.plan.init},signal());w.sensor.activate();p.fw.delayEcho(15);const r=await p.s.query(p.s.dictionary.encode('echo',{value:42}),'echo_response',signal(),{timeout:1});assert.equal(r.message.parameters.value,42);assert.equal(p.stops,0);assert.equal(w.sensor.status.active,true);assert.equal(p.s.status.pendingAcks,0);
 }finally{await p.close();}
});
for(const intervening of [1,20])test(`delayed response uses current sequence after ${intervening} intervening ACKs`,async()=>{
 const p=await pair();try{
  p.fw.holdEcho();
  const frames=p.fw.frames;
  const echo=p.s.query(p.s.dictionary.encode('echo',{value:73}),'echo_response',signal(),{timeout:1});
  const observed=echo.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  await until(()=>p.fw.frames>frames);
  for(let i=0;i<intervening;i++){
   const config=await p.s.query(p.s.dictionary.encode('get_config',{}),'config',signal(),{timeout:1});
   assert.equal(config.message.name,'config');
  }
  p.fw.releaseEcho();
  const result=await observed;
  assert.ifError(result.error);
  assert.equal(result.value!.message.parameters.value,73);
  assert.equal(p.stops,0);
 }finally{await p.close();}
});
