import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {ADCInput,compileADC} from '../src/inputs/adc.ts';
import {ADCTemperature} from '../src/thermal/adc.ts';
import {SerialADCTemperature} from '../src/thermal/serial-adc.ts';
import {Thermistor} from '../src/thermal/thermistor.ts';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
const fw=await serialFirmware();let raw:ADCInput|undefined,complete:(()=>void)|undefined,count=0,target=0;
const converter=new Thermistor(4700,0,{point:[25,100000],beta:3950}),value=Math.round(converter.adc(200)*32760),expected=converter.temperature(value/32760);
function sample(_t:number,temp:number){assert.ok(Math.abs(temp-expected)<1e-10);if(++count===target)complete?.();}
const session=new SerialSession(fw.fd,{async stopDevice(){},onMessage:r=>{raw?.receive(r.message);}});
try{
 const signal=new AbortController().signal;await session.initialize(signal);const chip={},pin={chip,chipName:'mcu',pin:'PA0',invert:0 as const,pullup:0 as const},now=Number(session.clock.sync.getClock(serialClock.now()))/1e6,clock=(t:number)=>BigInt(Math.trunc(t*1e6)),print=(n:bigint)=>Number(n)/1e6;
 const adapter=new ADCTemperature(converter,0,300,sample,()=>{}),plan=compileADC(chip,session.dictionary,{oid:3,pin,currentPrintTime:now,...adapter.sampling},clock);raw=new ADCInput(plan,n=>session.clock.sync.nearestClock(n),print,s=>adapter.receive(s));
 const sensor=new SerialADCTemperature(session,chip,{oid:4,pin,minimum:0,maximum:300,currentPrintTime:now},converter,clock,print,{sample,shutdown(){}});
 await session.configure({oidCount:5,commands:[...plan.commands,...sensor.plan.commands],init:[...plan.init,...sensor.plan.init]},signal);sensor.activate();
 const old:number[]=[],current:number[]=[],last=[0n,0n];
 for(let run=0;run<61;run++)for(const index of run%2?[1,0]:[0,1]){
  target=count+200;const done=new Promise<void>(resolve=>{complete=resolve;});const start=performance.now();
  for(let i=0;i<200;i++){let next=session.clock.sync.getClock(serialClock.now())+292000n;if(next<=last[index])next=last[index]+1n;last[index]=next;fw.emit('analog_in_state',{oid:index+3,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([value&255,value>>8])});}
  let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([done,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Temperature benchmark timeout')),2000);})]);}finally{clearTimeout(timeout);}
  if(run>=10)(index?current:old).push(performance.now()-start);
 }
 old.sort((a,b)=>a-b);current.sort((a,b)=>a-b);assert.equal(count,24400);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,reports:count,burst:200,samples:51,manualMedianMs:old[25],manualP95Ms:old[48],boundMedianMs:current[25],boundP95Ms:current[48],scope:'Same native session; alternating manual ADC+temperature onMessage versus OID subscription with freshness/lifecycle binding. Accelerated synthetic sensor reports, no electrical or physical safety claim.'},null,2));
}finally{await session.stop();await fw.close();}
