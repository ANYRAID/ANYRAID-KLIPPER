import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {compileConfiguredAnalogHeaters,attachConfiguredAnalogHeater} from '../src/config/analog-heater.ts';
import {stepperBatchFixture} from './helpers/configured-steppers.ts';
import {heaterReader,heaterClocks} from './helpers/configured-heater.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {type SensorTimer} from '../src/thermal/serial-adc.ts';
const requests=[{section:'extruder'}];
test('heater assembly preserves inversion, watchdog, ADC accumulation and global ownership',()=>{
 const f=stepperBatchFixture();mcuOids(f.pins).claim([{mcu:'mcu',owner:'stepper',oid:0}],()=>null);
 const [p]=compileConfiguredAnalogHeaters(heaterReader({heater_pin:'!PA2'}),f.pins,f.mcus,heaterClocks(),requests);
 assert.equal(p.output.pwm.oid,1);assert.equal(p.sensor.adc.oid,2);assert.equal(p.output.pwm.maximumDuration,3);assert.equal(p.output.pwm.startValue,1);assert.equal(p.output.pwm.shutdownValue,1);assert.equal(p.output.pwm.cycleTicks,100000);assert.equal(p.sensor.adc.maximumSum,32760);assert.match(p.sensor.adc.init[0],/sample_ticks=1000 sample_count=8 rest_ticks=300000 bytes_per_report=2 .*range_check_count=4/);
 assert.equal(p.output.pin,f.pins.claimedPins[0]);assert.equal(p.sensor.pin,f.pins.claimedPins[1]);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,3);
 for(const temperature of [0,25,170,300])assert(Math.abs(p.configuration.converter.temperature(p.configuration.converter.adc(temperature))-temperature)<1e-9);
});
test('ADC and heater may belong to separate MCUs with independent calibrated mappings',()=>{
 const f=stepperBatchFixture(),clocks=heaterClocks();clocks.get('mcu')!.calibration.frequency=1000000.5;
 const [p]=compileConfiguredAnalogHeaters(heaterReader({sensor_pin:'aux:PA0'}),f.pins,f.mcus,clocks,requests);assert.equal(p.output.pwm.oid,0);assert.equal(p.sensor.adc.oid,0);assert.equal(p.output.pwm.initialClock,1200001n);assert.equal(p.sensor.clock.offset,2);assert.match(p.sensor.adc.init[0],/clock=2000000 /);clocks.get('aux')!.calibration.offset=0;assert.equal(p.sensor.clock.offset,2);
});
test('invalid thermal controls and unsupported ADC polarity fail before claiming resources',()=>{
 for(const values of [{control:'unknown'},{min_temp:'400'},{pwm_cycle_time:'.4'},{sensor_pin:'^PA0'},{sensor_pin:'!PA0'},{sensor_type:'missing'}] as Record<string,string>[]){const f=stepperBatchFixture();assert.throws(()=>compileConfiguredAnalogHeaters(heaterReader(values),f.pins,f.mcus,heaterClocks(),requests));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);}
});
test('a conflicting or reserved sensor cannot leave its heater GPIO or OID claimed',()=>{
 for(const reserved of [false,true]){const f=stepperBatchFixture();if(reserved)f.pins.resolver('mcu').reserve('PA0','machine');assert.throws(()=>compileConfiguredAnalogHeaters(heaterReader(reserved?{}:{heater_pin:'PA0'}),f.pins,f.mcus,heaterClocks(),requests),/reserved|used multiple times/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
  assert.equal(compileConfiguredAnalogHeaters(heaterReader({sensor_pin:'PA1'}),f.pins,f.mcus,heaterClocks(),requests)[0].output.pwm.oid,0);
 }
});
test('heater and sensor explicit OIDs cannot collide or bypass MCU finalization',()=>{
 const f=stepperBatchFixture();assert.throws(()=>compileConfiguredAnalogHeaters(heaterReader(),f.pins,f.mcus,heaterClocks(),[{section:'extruder',pwmOid:2,adcOid:2}]),/Duplicate/);assert.equal(f.pins.claimedPins.length,0);mcuOids(f.pins).finalize('mcu');assert.throws(()=>compileConfiguredAnalogHeaters(heaterReader(),f.pins,f.mcus,heaterClocks(),requests),/finalized/);
});
const until=async(check:()=>boolean)=>{const end=performance.now()+2000;while(!check()){assert(performance.now()<end,'thermal event timeout');await delay(2);}};
for(const fault of ['range','stale'] as const)test(`compiled analog heater buffers startup samples, heats and stops on ${fault}`,async()=>{
 const fw=await serialFirmware(),signal=new AbortController().signal;let stops=0,runtime:AsyncHeaterRuntime|undefined;
 const group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);
 try{
  await group.start(signal);const session=group.session('mcu'),chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);
  const currentPrintTime=Number(session.clock.sync.getClock(serialClock.now()))/1e6,[p]=compileConfiguredAnalogHeaters(heaterReader(),pins,new Map([['mcu',{chip,dictionary:session.dictionary}]]),new Map([['mcu',{currentPrintTime,calibration:{offset:0,frequency:1e6}}]]),requests);
  const c=p.configuration;
  let offset=0,tick:(()=>void)|undefined;const timer:SensorTimer={now:()=>serialClock.now()+offset,schedule(callback){tick=callback;return ()=>{tick=undefined;};}};
  const binding=attachConfiguredAnalogHeater(group,p,{sensor:timer}),sensor=binding.sensor;runtime=binding.runtime;const heater=runtime;
  assert.throws(()=>attachConfiguredAnalogHeater(group,p),/ownership/);assert.throws(()=>attachConfiguredAnalogHeater(group,{...p}),/ownership/);
  assert.deepEqual(sensor.plan,p.sensor.adc);
  await session.configure({oidCount:mcuOids(pins).finalize('mcu').oidCount,commands:[...p.output.pwm.commands,...p.sensor.adc.commands],restart:p.output.pwm.restart,init:[...p.output.pwm.init,...p.sensor.adc.init],reservedMoves:1},signal);
  const emit=(raw:number)=>{const next=session.clock.sync.getClock(serialClock.now())+292000n;fw.emit('analog_in_state',{oid:p.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});};
  const raw=Math.round(c.converter.adc(25)*p.sensor.adc.maximumSum);emit(raw);await until(()=>sensor.status.lastSample!==undefined);assert.equal(heater.status.received,false);
  await assert.rejects(heater.setTarget(200,signal),/not active/);await binding.start(signal);assert(Math.abs(heater.status.lastTemperature-25)<.02);await heater.setTarget(200,signal);await delay(5);emit(raw);await until(()=>fw.outputs.some(m=>m.name==='queue_digital_out_generation'&&Number(m.parameters.on_ticks)>0));
  await heater.setTarget(0,signal);assert.equal(binding.outputStatus?.defaultConfirmed,true);assert.equal(heater.status.pendingWrites,0);assert.equal(heater.status.target,0);
  if(fault==='range'){await delay(5);emit(p.sensor.adc.maximumSum);}else{offset=8;tick!();}
  await until(()=>stops===1&&sensor.status.closed&&heater.status.stopped);await heater.shutdown();assert.equal(heater.status.target,0);assert.equal(heater.status.outputStopConfirmed,true);assert.equal(sensor.status.active,false);assert.equal(session.configuration.moveSlots,511);
 }finally{await runtime?.shutdown().catch(()=>{});await group.stop();await fw.close();}
});
for(const configured of [false,true])test(`attached heater requires configured MCUs and fresh samples (configured=${configured})`,async()=>{
 const fw=await serialFirmware(),signal=new AbortController().signal;let stops=0;
 const group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);
 try{
  await group.start(signal);const session=group.session('mcu'),chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);const [p]=compileConfiguredAnalogHeaters(heaterReader(),pins,new Map([['mcu',{chip,dictionary:session.dictionary}]]),new Map([['mcu',{currentPrintTime:Number(session.clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]),requests),binding=attachConfiguredAnalogHeater(group,p);
  if(configured){await session.configure({oidCount:mcuOids(pins).finalize('mcu').oidCount,commands:[...p.output.pwm.commands,...p.sensor.adc.commands],init:[...p.output.pwm.init,...p.sensor.adc.init],reservedMoves:1},signal);await binding.start(signal);await assert.rejects(binding.runtime.setTarget(200,signal),/Fresh/);assert.equal(binding.runtime.status.target,0);assert.equal(stops,0);await binding.stop();}
  else{await assert.rejects(binding.start(signal),/configured/);assert.equal(stops,1);assert.equal(binding.sensor.status.closed,true);assert.equal(binding.outputStatus,undefined);}
  assert.equal(fw.outputs.filter(m=>m.name==='queue_digital_out_generation'&&Number(m.parameters.on_ticks)>0).length,0);
 }finally{await group.stop();await fw.close();}
});
