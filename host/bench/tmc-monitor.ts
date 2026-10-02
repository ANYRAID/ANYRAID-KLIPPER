import assert from 'node:assert/strict';
import {serialFirmware} from '../test/helpers/serial-firmware.ts';
import {FakeClock} from '../test/helpers/clock-scheduler.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {sessionTmcUart} from '../src/drivers/tmc-uart-mcu.ts';
import {encodeTmcWrite} from '../src/drivers/tmc-uart.ts';
import {Tmc220xMonitor} from '../src/drivers/tmc220x-monitor.ts';
const firmware=await serialFirmware(undefined,{tmcUart(_oid,write){const reg=((write[2]|write[3]<<8)>>>5)&127;return {data:encodeTmcWrite(255,reg,0,true)};}}),session=new SerialSession(firmware.fd,{async stopDevice(){}}),clock=new FakeClock(),monitors:Tmc220xMonitor[]=[],signal=new AbortController().signal;
try{
 await session.initialize(signal);await session.configure({oidCount:1,commands:['config_tmcuart oid=0 rx_pin=PA0 pull_up=0 tx_pin=PA0 bit_time=25']},signal);
 const bus=sessionTmcUart(session);for(let address=0;address<4;address++){const m=new Tmc220xMonitor(bus.register(0,address),e=>{throw e;},clock);monitors.push(m);await m.start(signal);}
 const samples:number[]=[];
 for(let i=0;i<120;i++){
  const start=performance.now();await clock.advance(1);const target=i+2;while(monitors.some(m=>m.status.checks<target)){if(performance.now()-start>2000)throw new Error('Monitor benchmark timed out');await new Promise<void>(r=>setImmediate(r));}
  if(i>=20)samples.push(performance.now()-start);
 }
 samples.sort((a,b)=>a-b);assert(monitors.every(m=>!m.status.fault));console.log(JSON.stringify({node:process.version,drivers:4,queriesPerSweep:8,warmups:20,samples:100,medianMs:samples[50],p95Ms:samples[94],maxMs:samples[99],scope:'Native serialqueue and simulated UART replies; virtual one-second ticks; no physical UART latency or printing'}));
}finally{await Promise.all(monitors.map(m=>m.stop()));await session.stop();await firmware.close();}
