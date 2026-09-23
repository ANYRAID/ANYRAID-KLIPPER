import {encodeFrame} from '../src/protocol/codec.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {hardwareLayout,hardwareClocks,hardwareReader,hardwareFixture} from './helpers/configured-hardware.ts';
import {configureMCU} from '../src/protocol/mcu-config.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {attachConfiguredAnalogHeater} from '../src/config/analog-heater.ts';
test('hardware assembly collects every device and partitions OIDs and move reservations by MCU',()=>{
 const f=hardwareFixture(),p=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),hardwareLayout),[main,aux]=p.configurations;
 assert.equal(main.plan.oidCount,4);assert.equal(aux.plan.oidCount,5);assert.equal(main.plan.reservedMoves,1);assert.equal(aux.plan.reservedMoves,3);
 assert.deepEqual(main.resources.owners.map(o=>o.oid),[0,1,2,3]);assert.deepEqual(aux.resources.owners.map(o=>o.oid),[0,1,2,3,4]);
 assert.equal(p.steppers[0].stepDistance,.0125);assert.equal(p.steppers[0].emitter,'x');assert.equal(p.steppers[0].physicalMember,0);
 assert.equal(p.homing[0].primary,0);assert.equal(p.homing[0].triggers[1].protocol.oid,0);
 assert.equal(p.heaters[0].output.pwm.oid,3);assert.equal(p.heaters[0].sensor.adc.oid,4);
 assert(main.plan.commands.some(c=>c.includes('step_pin=PA0 dir_pin=PA1')));
 assert.deepEqual(main.plan.restart,[p.steppers[0].restart,p.motors.lines[0].config.restart,...p.homing[0].endstop.restart,...p.homing[0].triggers[0].protocol.restart]);
 assert.deepEqual(aux.plan.init,[...p.fans[0].output.pwm.init,...p.fans[0].enable!.pwm.init,...p.heaters[0].output.pwm.init,...p.heaters[0].sensor.adc.init]);
 assert(Object.isFrozen(p.configurations)&&Object.isFrozen(main.plan.commands)&&Object.isFrozen(main.resources.owners));
});
test('late cross-device pin collisions publish no partial assembly and corrected input retries deterministically',()=>{
 const f=hardwareFixture();assert.throws(()=>compileConfiguredHardware(hardwareReader('PA0_ALIAS'),f.group,hardwareClocks(),hardwareLayout),/used multiple times|exclusively/);
 const good=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),hardwareLayout),again=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),hardwareLayout);
 assert.deepEqual(good.configurations.map(c=>c.plan),again.configurations.map(c=>c.plan));
});
test('configured sessions, missing clocks, duplicate emitters and reserved board pins cannot assemble',()=>{
 const f=hardwareFixture(),clocks=hardwareClocks();f.sessions.get('aux')!.status.configured=true;
 assert.throws(()=>compileConfiguredHardware(hardwareReader(),f.group,clocks,hardwareLayout),/unconfigured/);f.sessions.get('aux')!.status.configured=false;
 clocks.delete('aux');assert.throws(()=>compileConfiguredHardware(hardwareReader(),f.group,clocks,hardwareLayout),/Missing hardware clock/);
 assert.throws(()=>compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),{...hardwareLayout,steppers:[...hardwareLayout.steppers,...hardwareLayout.steppers]}),/Duplicate hardware emitter/);
 assert.throws(()=>compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),{...hardwareLayout,boards:[{mcu:'mcu',aliases:{STEP:'PA0'},reserved:['PA0']}]}),/reserved/);
});
test('empty controllers consume no phantom move slots',()=>{
 const f=hardwareFixture(),p=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),{steppers:[],homing:[],fans:[],heaters:[]});
 assert.equal(p.configurations.length,2);for(const c of p.configurations)assert.deepEqual(c.plan,{oidCount:0,commands:[],restart:[],init:[],reservedMoves:0});
});
test('all assembled plans pass real configuration CRC encoding and reused initialization',async()=>{
 const f=hardwareFixture(),p=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),hardwareLayout),signal=new AbortController().signal;
 for(const c of p.configurations){let crc=0,configured=0;const sent:string[]=[];
  const transport={async query(){return {message:{name:'config',parameters:{is_config:configured,crc,is_shutdown:0,move_count:512}}} as never;},async send(payload:Uint8Array){const command=c.session.dictionary.parseFrame(encodeFrame(0,payload))[0];sent.push(command.name);if(command.name==='finalize_config'){crc=Number(command.parameters.crc);configured=1;}},async stop(){assert.fail('valid complete plan must not stop');}};
  const first=await configureMCU(c.session.dictionary,transport,c.plan,signal);assert.equal(first.moveSlots,512-c.plan.reservedMoves!);assert.equal(first.reused,false);
  sent.length=0;const reused=await configureMCU(c.session.dictionary,transport,c.plan,signal);assert.equal(reused.reused,true);assert.equal(reused.crc,first.crc);assert(!sent.includes('allocate_oids'));assert.equal(sent.length,c.plan.restart!.length+c.plan.init!.length);
 }
});
test('native two-MCU startup configures collected stepper, shared resources and subscribed heater',async()=>{
 const firmware=await Promise.all([serialFirmware(undefined,{triggerSync:true,stepperBytePins:true}),serialFirmware(undefined,{triggerSync:true,stepperBytePins:true})]),signal=new AbortController().signal;
 const group=new MCUGroup(['mcu','aux'].map((id,i)=>({id,async connect(s:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const session=new SerialSession(firmware[i].fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}})));
 try{
  await group.start(signal);const clocks=hardwareClocks();for(const [id,c] of clocks)c.currentPrintTime=Number(group.session(id).clock.sync.getClock(serialClock.now()))/1e6;
  const p=compileConfiguredHardware(hardwareReader(),group,clocks,hardwareLayout),heater=attachConfiguredAnalogHeater(group,p.heaters[0]);
  assert.deepEqual(heater.sensor.plan,p.heaters[0].sensor.adc);
  for(const c of p.configurations)await c.session.configure(c.plan,signal);
  assert.equal(firmware[0].stepperConfigs.length,1);assert.equal(firmware[0].stepperConfigs[0].oid,0);
  assert.equal(group.session('mcu').configuration.moveSlots,511);assert.equal(group.session('aux').configuration.moveSlots,509);
  assert.equal(firmware[1].outputs.filter(c=>c.name==='query_analog_in').length,1);
  await heater.start(signal);assert.equal(heater.outputStatus?.defaultConfirmed,true);await assert.rejects(heater.runtime.setTarget(200,signal),/Fresh/);
  assert.throws(()=>compileConfiguredHardware(hardwareReader(),group,clocks,hardwareLayout),/unconfigured/);
  await heater.stop();
 }finally{await group.stop();await Promise.all(firmware.map(f=>f.close()));}
});
test('hardware assembly shares one private timeline per MCU across peripheral plans',()=>{
 const f=hardwareFixture(),clocks=hardwareClocks(),plan=compileConfiguredHardware(hardwareReader(),f.group,clocks,hardwareLayout),main=plan.configurations.find(c=>c.mcu==='mcu')!.timeline,aux=plan.configurations.find(c=>c.mcu==='aux')!.timeline;
 assert.notEqual(main,aux);assert.equal(plan.motors.lines[0].timeline,main);assert.equal(plan.fans[0].output.timeline,aux);assert.equal(plan.fans[0].enable!.timeline,aux);assert.equal(plan.heaters[0].output.timeline,aux);assert.equal(plan.heaters[0].sensor.timeline,aux);
 clocks.get('aux')!.calibration.frequency=2e6;assert.equal(aux.status.calibration.frequency,1e6);aux.append(5000000n,1000100);
 for(const clock of [plan.fans[0].output.clock,plan.heaters[0].output.clock,plan.heaters[0].sensor.clock])assert.equal(clock.clockAt(6),aux.clockAt(6));assert.equal(main.clockAt(6),6000000n);
 const other=compileConfiguredHardware(hardwareReader(),f.group,hardwareClocks(),hardwareLayout);assert.notEqual(other.configurations[0].timeline,plan.configurations[0].timeline);
});
