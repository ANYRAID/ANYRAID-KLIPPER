import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {AhtSensor} from '../src/thermal/aht.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {heaterStopTrace} from './helpers/heater-stop-trace.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
for(const pin of ['PA4','aux:PA4'])test(`AHT stop evidence preserves the first MCU cause through native timer cancellation: ${pin}`,async t=>{
 let reads=0;const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_bytes,n)=>{if(n)reads++;const raw=Math.round(75*1048576/200);return {data:n?Uint8Array.of(8,128,0,raw>>>16,raw>>>8&255,raw&255):Buffer.alloc(0),status:'SUCCESS'};}),trace=heaterStopTrace(f),entered=Promise.withResolvers<void>(),original=AhtSensor.prototype.sample;
 let calls=0,owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 // Hold only the controlled second request in Node's real abortable timer.
 // Original CI trigger and all production sample/clock/watchdog limits remain open.
 t.mock.method(AhtSensor.prototype,'sample',async function(this:AhtSensor,s:AbortSignal){if(++calls===2){entered.resolve();await delay(10000,undefined,{signal:s});}return original.call(this,s);});
 try{
  const section='heater_generic chamber',reader=new ConfigurationReader(new ConfigurationSource('/aht-stop.cfg',{[section]:{sensor_type:'AHT2X',i2c_mcu:'aux',i2c_bus:'i2c1',heater_pin:pin,min_temp:'0',max_temp:'100',min_extrude_temp:'0',control:'watermark'}},[]),null);
  owner=await startConfiguredHardware(reader,f.group,f.clocks,{steppers:[],homing:[],fans:[],heaters:[{section}]},{beforeTarget(){}},f.signal);
  trace.stage('controlled-target-sample');const target=owner.heaters.setTarget('chamber',40,f.signal),rejected=target.then(()=>assert.fail('Retired target request succeeded'),error=>error);await entered.promise;
  const first=new Error('Controlled MCU stop during AHT sample');await f.group.stop(first);const error=await rejected;await owner.close();
  assert.equal(error.name,'AbortError');assert.equal(error.code,'ABORT_ERR');assert.equal(error.cause,'Configured hardware stopped');assert.equal(f.group.status.fault,first);assert.equal(owner.status.fault,first);
  const evidence=trace.snapshot();assert.deepEqual(evidence.firstStop?.cause,{name:'Error',message:first.message,cause:null});assert.equal(evidence.firstStop?.stage,'controlled-target-sample');assert.equal(evidence.group.state,'stopped');
  assert.equal(owner.status.state,'stopped');assert.deepEqual(f.stops,[1,1]);assert.equal(reads,1);assert.equal(calls,2);assert.equal(owner.thermal[0].runtime.status.outputStopConfirmed,true);assert.equal(owner.thermal[0].runtime.getTemperature().target,0);
  assert.equal(f.firmware.flatMap(fw=>fw.outputs).filter(row=>row.name==='queue_digital_out_generation'&&Number(row.parameters.on_ticks)>0).length,0);
  t.diagnostic(JSON.stringify({controlledAhtStop:{pin,error:{name:error.name,code:error.code,cause:error.cause},...evidence,originalCIFaultCaptured:false}}));
 }finally{t.mock.restoreAll();await owner?.close();trace.close();await f.close();}
});
