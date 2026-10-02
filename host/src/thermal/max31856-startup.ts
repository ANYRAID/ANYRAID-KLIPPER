import {setTimeout as delay} from 'node:timers/promises';
import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {compileConfiguredSpiSensors} from '../config/spi-temperature.ts';

/** Initialization only: no transport retry, and no output activation until this
 * completes. Preserve the old filter when disabling conversion. Wait for an
 * outstanding 16-sample conversion before changing CR1/filter, then read back.
 * Datasheet Rev 0 pp 4,19-20: base conversion max 185ms, averaging adds
 * 15*40ms nominal; use a conservative 1 second settling interval.
 * The normal fault register is checked on every subsequent MCU report. */
export async function startMax31856<T>(session:SerialSession,plan:ReturnType<typeof compileConfiguredSpiSensors<T>>[number],signal:AbortSignal){
 const config=plan.chipConfiguration;if(plan.model!=='MAX31856'||!config)throw new Error('Missing MAX31856 initialization plan');
 const d=session.dictionary,queue=session.commandQueue(),oid=plan.spi.oid;
 const send=async(data:number[])=>{await queue.send(d.encode('spi_send',{oid,data:Buffer.from(data)}),0n,0n,signal);signal.throwIfAborted();};
 const read=async(register:number,length:number)=>{
  const data=Buffer.alloc(length+1);data[0]=register;
  const r=await session.queryOnQueue(queue,d.encode('spi_transfer',{oid,data}),'spi_transfer_response',signal,{oid,retries:0,timeout:5}),bytes=r.message.parameters.response;
  if(r.message.name!=='spi_transfer_response'||r.message.parameters.oid!==oid||!(bytes instanceof Uint8Array)||bytes.length!==data.length)throw new Error('Invalid MAX31856 register response');
  signal.throwIfAborted();return bytes.slice(1);
 };
 const previous=await read(0,1);await send([0x80,previous[0]&1]);
 if((await read(0,1))[0]!== (previous[0]&1))throw new Error('MAX31856 standby readback mismatch');
 await delay(1000,undefined,{signal});
 const desired=[config.filter,config.type|config.average,3];
 await send([0x80,...desired]);
 const actual=await read(0,3);if(actual.some((v,i)=>v!==desired[i]))throw new Error('MAX31856 configuration readback mismatch');
 await send([0x80,0x80|config.filter]);
 if((await read(0,1))[0]!== (0x80|config.filter))throw new Error('MAX31856 conversion mode readback mismatch');
 await delay(1000,undefined,{signal});
 // The planning clock can be past after initialization; arm from the current
 // calibrated MCU clock, not the stale configuration-time estimate.
 const clock=session.clock.sync.getClock(serialClock.now())+BigInt(plan.reportTicks);
 await queue.send(d.encode('query_thermocouple',{oid:plan.oid,clock:Number(BigInt.asUintN(32,clock)),rest_ticks:plan.reportTicks,min_value:plan.range.minimum,max_value:plan.range.maximum,max_invalid_count:3}),0n,0n,signal);
}
