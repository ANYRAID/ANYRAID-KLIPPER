import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {EndstopProtocol} from '../src/inputs/endstop.ts';
import {HomingStopConfirmation} from '../src/homing/stop-confirmation.ts';
const signal=new AbortController().signal;
async function fixture(){const fw=await serialFirmware(undefined,{triggerSync:true}),session=new SerialSession(fw.fd,{async stopDevice(){}});await session.initialize(signal);const trigger=new TriggerSyncProtocol(session.dictionary,8),chip={},endstop=new EndstopProtocol(chip,session.dictionary,7,{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1});await session.configure({oidCount:9,commands:[...trigger.commands,...endstop.commands]},signal);const queue=session.commandQueue();fw.setTriggerReason(1);return {fw,session,queue,trigger,endstop,steppers:[{oid:1,inverted:false},{oid:2,inverted:true}],async close(){await session.stop();await fw.close();}};}
const a=await fixture(),b=await fixture();
try{
 const start=a.session.clock.sync.getClock(serialClock.now()),sampling=a.endstop.home({printTime:Number(start)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.trunc(t*1e6)));
 a.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(sampling.reqClock+sampling.restTicks)});
 async function raw(){await a.queue.send(a.endstop.stop(),0n,0n,signal);await Promise.all([a,b].map(m=>m.session.queryOnQueue(m.queue,m.trigger.trigger(2),'trsync_state',signal,{oid:8})));await a.session.queryOnQueue(a.queue,a.endstop.query(),'endstop_state',signal,{oid:7});await Promise.all([a,b].map(async m=>{for(const step of m.steppers)await m.session.queryOnQueue(m.queue,m.session.dictionary.encode('stepper_get_position',{oid:step.oid}),'stepper_position',signal,{oid:step.oid});}));}
 const times:number[][]=[[],[]];
 for(let round=0;round<14;round++)for(const mode of round%2?[1,0]:[0,1]){
  const before=performance.now();for(let i=0;i<20;i++)if(mode){const result=await new HomingStopConfirmation([a,b],0,a.endstop,sampling,()=>{}).finish(signal);assert.equal(result.hitClock,sampling.reqClock);assert.equal(result.positions.length,4);}else await raw();
  if(round>=3)times[mode].push(performance.now()-before);
 }
 for(const t of times)t.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,operationsPerBatch:20,mcus:2,steppers:4,rawSequenceMedianMs:times[0][5],rawSequenceP95Ms:times[0][10],validatedMedianMs:times[1][5],validatedP95Ms:times[1][10],scope:'same simulated serial transport; original raw baseline omits validated MCU uptime observations; excludes native group release, real motion, compressor reconciliation and hardware'},null,2));
 assert.ok(times[1][5]<=times[0][5]*1.5,'Stop confirmation overhead exceeded 50%');
}finally{await a.close();await b.close();}
