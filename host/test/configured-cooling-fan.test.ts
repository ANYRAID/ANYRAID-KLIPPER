import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredCoolingFans} from '../src/config/cooling-fan.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture,batchReader} from './helpers/configured-steppers.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
const reader=(options:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/fan.cfg',{fan:{pin:'PA2',...options}},[]),null),requests=[{section:'fan',minimumScheduleTime:.001}],clocks=()=>new Map([['mcu',{currentPrintTime:1,calibration:{offset:0,frequency:1e6}}],['aux',{currentPrintTime:3,calibration:{offset:2,frequency:1e6}}]]);
test('default software PWM shares global stepper OIDs and preserves inverted zero defaults',()=>{
 const f=stepperBatchFixture();compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x'}]);const [p]=compileConfiguredCoolingFans(reader({pin:'!PA2'}),f.pins,f.mcus,clocks(),requests);
 assert.equal(p.output.pwm.oid,1);assert.equal(p.output.pwm.hardware,false);assert.equal(p.output.pwm.cycleTicks,10000);assert.equal(p.output.pwm.initialClock,1200000n);assert.equal(p.output.pwm.startValue,1);assert.equal(p.output.pwm.shutdownValue,1);assert.equal(p.output.pwm.maximumDuration,0);assert.equal(p.output.pin,f.pins.claimedPins[2]);assert.equal(p.config.kickStartTime,.1);assert.equal(p.config.maxPower,1);assert.equal(p.enable,undefined);assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,2);
});
test('hardware fan and cross-MCU enable use independent clock snapshots and IDs',()=>{
 const f=stepperBatchFixture(),mapping=clocks(),[p]=compileConfiguredCoolingFans(reader({hardware_pwm:'true',enable_pin:'!aux:PA3',max_power:'.8',kick_start_time:'0',off_below:'.2'}),f.pins,f.mcus,mapping,requests);
 assert.equal(p.output.pwm.hardware,true);assert.equal(p.output.pwm.maxValue,255);assert.equal(p.enable!.pwm.hardware,false);assert.equal(p.output.pwm.oid,0);assert.equal(p.enable!.pwm.oid,0);assert.equal(p.enable!.pwm.initialClock,1200000n);assert.equal(p.enable!.clock.offset,2);mapping.get('aux')!.calibration.offset=0;assert.equal(p.enable!.clock.offset,2);assert.equal(p.config.maxPower,.8);assert.equal(p.config.offBelow,.2);assert.equal(f.pins.claimedPins.length,2);
});
test('enable pin conflict rolls back both output OIDs and allows correction',()=>{
 const f=stepperBatchFixture();assert.throws(()=>compileConfiguredCoolingFans(reader({pin:'PA3',enable_pin:'PA3_ALIAS'}),f.pins,f.mcus,clocks(),requests),/used multiple times/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 const [p]=compileConfiguredCoolingFans(reader({enable_pin:'PA3'}),f.pins,f.mcus,clocks(),requests);assert.equal(p.output.pwm.oid,0);assert.equal(p.enable!.pwm.oid,1);
});
test('calibrated drift changes the initial clock without changing nominal PWM cycle ticks',()=>{
 const f=stepperBatchFixture(),mapping=clocks();mapping.get('mcu')!.calibration.frequency=1000000.5;
 const [p]=compileConfiguredCoolingFans(reader(),f.pins,f.mcus,mapping,requests);assert.equal(p.output.pwm.initialClock,1200001n);assert.equal(p.output.pwm.cycleTicks,10000);assert.equal(p.output.clock.frequency,1000000.5);assert.equal(p.output.clock.clockAt(p.output.clock.printTimeAtClock(1200001n)),1200001n);
});
test('unsupported thermal defaults, tachometer, invalid duty and invalid clock fail without claims',()=>{
 for(const options of [{shutdown_speed:'.1'},{tachometer_pin:'PA5'},{max_power:'0'},{cycle_time:'0'},{off_below:'2'},{kick_start_time:'-1'}] as Record<string,string>[]){const f=stepperBatchFixture();assert.throws(()=>compileConfiguredCoolingFans(reader(options),f.pins,f.mcus,clocks(),requests));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);}
 const f=stepperBatchFixture(),mapping=clocks();mapping.get('mcu')!.calibration.frequency=NaN;assert.throws(()=>compileConfiguredCoolingFans(reader(),f.pins,f.mcus,mapping,requests),/clock mapping/);assert.equal(f.pins.claimedPins.length,0);
});
test('generation reset support is validated before publishing any resources',()=>{
 const f=stepperBatchFixture(),d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':2,'queue_pwm_out oid=%c clock=%u value=%hu':3},responses:{},enumerations:{pin:{PA2:2}},config:{CLOCK_FREQ:1e6,PWM_MAX:255}})),false);f.mcus.get('mcu')!.dictionary=d;
 assert.throws(()=>compileConfiguredCoolingFans(reader({hardware_pwm:'true'}),f.pins,f.mcus,clocks(),requests));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
});
test('reserved physical aliases and sealed OIDs reject fan outputs',()=>{
 const f=stepperBatchFixture(true);assert.throws(()=>compileConfiguredCoolingFans(reader({pin:'PA3_ALIAS'}),f.pins,f.mcus,clocks(),requests),/reserved/);assert.equal(f.pins.claimedPins.length,0);
 const g=stepperBatchFixture();mcuOids(g.pins).finalize('mcu');assert.throws(()=>compileConfiguredCoolingFans(reader(),g.pins,g.mcus,clocks(),requests),/finalized/);assert.equal(g.pins.claimedPins.length,0);
});
test('compiled PWM plus enable run through native queues and confirm generation reset',async()=>{
 const fw=await serialFirmware(),signal=new AbortController().signal;let stops=0;
 const group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);
 try{
  await group.start(signal);const session=group.session('mcu'),chip={},pins=new PrinterPins<object>();pins.register('mcu',chip);
  const [p]=compileConfiguredCoolingFans(reader({hardware_pwm:'true',enable_pin:'!PA1',max_power:'.8',kick_start_time:'0'}),pins,new Map([['mcu',{chip,dictionary:session.dictionary}]]),new Map([['mcu',{currentPrintTime:Number(session.clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]),requests),outputs=[p.output,p.enable!];
  await session.configure({oidCount:mcuOids(pins).finalize('mcu').oidCount,commands:outputs.flatMap(o=>o.pwm.commands),restart:outputs.flatMap(o=>o.pwm.restart),init:outputs.flatMap(o=>o.pwm.init),reservedMoves:2},signal);
  const adapters=outputs.map(o=>new GenerationPWMOutput(o.pwm,session.dictionary,group.commandQueue('mcu'),group.commandQueue('mcu'),o.clock.clockAt,o.clock.printTimeAtClock)),fan=new ScheduledCoolingFan(adapters[0],p.config,adapters[1]);await fan.start(signal);
  const time=Number(session.clock.sync.getClock(serialClock.now()))/1e6+.3;fan.enqueue(time,.5);await fan.flush(time,signal);fan.enqueue(time+.1,0);await fan.flush(time+.1,signal);
  assert.deepEqual(fw.outputs.filter(m=>m.name==='queue_pwm_out_generation').map(m=>m.parameters.value),[102,0]);assert.deepEqual(fw.outputs.filter(m=>m.name==='queue_digital_out_generation').map(m=>m.parameters.on_ticks),[0,10000]);assert.equal(session.configuration.moveSlots,510);
  await fan.off(signal);assert(adapters.every(a=>a.status.defaultConfirmed&&a.status.pendingWrites===0));assert.equal(fan.status.speed,0);assert.equal(stops,0);
 }finally{await group.stop();await fw.close();}
});
