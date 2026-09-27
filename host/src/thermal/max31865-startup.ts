import {setTimeout as delay} from 'node:timers/promises';
import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {compileConfiguredSpiSensors} from '../config/spi-temperature.ts';
/** MAX31865 Rev 3 pp3,13-16. Standby before changing filter; settle bias
 * before conversion. 100ms exceeds the 66ms first conversion and the documented
 * 10k reference / 0.1uF input network settling time. No automatic fault retry. */
export async function startMax31865<T>(session:SerialSession,plan:ReturnType<typeof compileConfiguredSpiSensors<T>>[number],signal:AbortSignal){
 const config=plan.rtdConfiguration;if(plan.model!=='MAX31865'||!config||!plan.rtd)throw new Error('Missing MAX31865 initialization plan');
 const d=session.dictionary,queue=session.commandQueue(),oid=plan.spi.oid;
 const send=async(data:number[])=>{await queue.send(d.encode('spi_send',{oid,data:Buffer.from(data)}),0n,0n,signal);signal.throwIfAborted();};
 const read=async(address:number,count:number)=>{
  const data=Buffer.alloc(count+1);data[0]=address;
  const result=await session.queryOnQueue(queue,d.encode('spi_transfer',{oid,data}),'spi_transfer_response',signal,{oid,retries:0,timeout:5}),bytes=result.message.parameters.response;
  if(result.message.name!=='spi_transfer_response'||result.message.parameters.oid!==oid||!(bytes instanceof Uint8Array)||bytes.length!==data.length)throw new Error('Invalid MAX31865 register response');
  signal.throwIfAborted();return bytes.slice(1);
 };
 const previous=await read(0,1),standby=previous[0]&0x91;
 await send([0x80,standby]);if((await read(0,1))[0]!==standby)throw new Error('MAX31865 standby readback mismatch');
 await delay(100,undefined,{signal});
 const bias=0x80|(config.wires===3?0x10:0)|config.filter;
 await send([0x80,bias|2]);if((await read(0,1))[0]!==bias)throw new Error('MAX31865 bias readback mismatch');
 // Reset thresholds retained across host restarts. Precise temperature bounds
 // are enforced by the MCU query and host decoder; these are POR defaults.
 await send([0x83,0xff,0xff,0,0]);
 const thresholds=await read(3,4);if(thresholds.some((v,i)=>v!==[255,255,0,0][i]))throw new Error('MAX31865 threshold readback mismatch');
 await delay(100,undefined,{signal});
 await send([0x80,bias|0x40]);if((await read(0,1))[0]!== (bias|0x40))throw new Error('MAX31865 conversion readback mismatch');
 await delay(100,undefined,{signal});
 if((await read(7,1))[0]!==0)throw new Error('MAX31865 startup fault');
 const clock=session.clock.sync.getClock(serialClock.now())+BigInt(plan.reportTicks);
 await queue.send(d.encode('query_thermocouple',{oid:plan.oid,clock:Number(BigInt.asUintN(32,clock)),rest_ticks:plan.reportTicks,min_value:plan.range.minimum,max_value:plan.range.maximum,max_invalid_count:3}),0n,0n,signal);
}
