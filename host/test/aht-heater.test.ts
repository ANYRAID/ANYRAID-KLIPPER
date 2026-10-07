import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {heaterStopTrace,stopCause} from './helpers/heater-stop-trace.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
for(const pin of ['PA4','aux:PA4'])test(`AHT heater requests fresh target feedback and renews PWM without forging samples: ${pin}`,async t=>{
 let temperature=25,fault=false,reads=0;const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_bytes,n)=>{if(n)reads++;const raw=Math.round((temperature+50)*1048576/200);return {data:n?Uint8Array.of(8,128,0,raw>>>16,raw>>>8&255,raw&255):Buffer.alloc(0),status:fault?'NACK':'SUCCESS'};});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;const trace=heaterStopTrace(f);let failed=false,primary:unknown;
 const section='heater_generic chamber',reader=new ConfigurationReader(new ConfigurationSource('/aht-heater.cfg',{[section]:{sensor_type:'AHT2X',i2c_mcu:'aux',i2c_bus:'i2c1',heater_pin:pin,min_temp:'0',max_temp:'100',min_extrude_temp:'0',control:'watermark'}},[]),null);
 try{
  trace.stage('hardware-start');owner=await startConfiguredHardware(reader,f.group,f.clocks,{steppers:[],homing:[],fans:[],heaters:[{section}]},{beforeTarget(){}},f.signal);
  const heater=owner.thermal[0].runtime,p=owner.plan.i2cHeaters[0],fw=f.firmware[p.output.mcu==='mcu'?0:1],writes=()=>fw.outputs.filter(e=>e.name==='queue_digital_out_generation'&&e.parameters.oid===p.output.pwm.oid&&Number(e.parameters.on_ticks)>0);
  assert.equal(heater.getTemperature().temperature,25);assert.equal(writes().length,0);assert.equal(p.configuration.settings.sampleTimeout,36);assert.equal(p.configuration.verification.checkGainTime,36);
  trace.stage('initial-target');await owner.heaters.setTarget('chamber',40,f.signal);const deadline=performance.now()+1500;while(!writes().length){assert(performance.now()<deadline,JSON.stringify(heater.status));await delay(10);}assert.equal(reads,2);const measured=heater.status.lastTime;
  trace.stage('pwm-renewal');await delay(4300);assert.equal(owner.status.state,'ready');assert.equal(reads,2);assert.equal(heater.status.lastTime,measured);assert(writes().length>=2);
  trace.stage('fresh-target');temperature=45;await owner.heaters.setTarget('chamber',35,f.signal);await delay(30);assert.equal(reads,3);assert.equal(heater.objectStatus.power,0);assert(heater.status.lastTime>measured);
  trace.stage('intentional-nack');fault=true;await assert.rejects(owner.heaters.setTarget('chamber',40,f.signal));await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(heater.status.outputStopConfirmed,true);assert.equal(heater.getTemperature().target,0);
 }catch(error){failed=true;primary=error;t.diagnostic(JSON.stringify({ahtFirstFault:{pin,error:stopCause(error),...trace.snapshot(),hardware:owner?{state:owner.status.state,fault:stopCause(owner.status.fault),stopError:stopCause(owner.status.stopError)}:undefined}}));throw error;}finally{const cleanup:unknown[]=[];for(const close of [()=>owner?.close(),()=>f.close()])try{await close();}catch(error){cleanup.push(error);}trace.close();if(cleanup.length)throw new AggregateError(failed?[primary,...cleanup]:cleanup,'AHT test cleanup failed');}
});
