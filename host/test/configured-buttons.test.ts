import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from './helpers/configured-hardware.ts';
const first='filament_switch_sensor tool',second='filament_switch_sensor spool';
const reader=(pin='^!PA4')=>new ConfigurationReader(new ConfigurationSource('/switch.cfg',{...hardwareReader().source.original,[first]:{switch_pin:pin},[second]:{switch_pin:'^aux:PA6'}},[]),null);
const layout={...hardwareLayout,buttons:[{section:first},{section:second}]};
const until=async(check:()=>boolean)=>{const deadline=performance.now()+2000;while(!check()){assert(performance.now()<deadline,'switch observation timeout');await delay(2);}};
test('switch assembly shares OID and pin ownership with motors, heaters and fans',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,true);try{
  assert.throws(()=>compileConfiguredHardware(reader('aux:PA0'),f.group,f.clocks,layout),/used multiple|exclusively/);assert(f.group.status.devices.every(d=>!f.group.session(d.id).status.configured));assert.deepEqual(f.stops,[0,0]);
  const p=compileConfiguredHardware(reader(),f.group,f.clocks,layout);assert.deepEqual(p.buttons.map(b=>[b.mcu,b.buttons.oid,b.buttons.invert]),[['mcu',4,1],['aux',5,0]]);assert.equal(p.configurations[0].plan.oidCount,5);assert.equal(p.configurations[1].plan.oidCount,6);assert.equal(p.configurations[1].plan.reservedMoves,3);
 }finally{await f.close();}
});
test('configured switch lifecycle publishes both MCU inputs and faults all owners on a gap',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,true);try{
  const owner=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),events:boolean[]=[];
  const input=owner.buttons[0].input;assert.equal(input.status.received,false);const detach=input.subscribe((_t,p)=>events.push(p));
  f.firmware[0].emit('buttons_state',{oid:4,ack_count:0,state:Buffer.from([0,1])});f.firmware[1].emit('buttons_state',{oid:5,ack_count:0,state:Buffer.from([1])});
  await until(()=>events.length===2&&owner.buttons[1].input.status.received);assert.deepEqual(events,[true,false]);assert.equal(input.status.present,false);assert.equal(owner.buttons[1].input.status.present,true);detach();
  f.firmware[0].emit('buttons_state',{oid:4,ack_count:20,state:Buffer.from([0])});await until(()=>owner.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert(owner.buttons.every(b=>b.input.status.closed));assert.match(String(owner.status.fault),/gap/);
 }finally{await f.close();}
});
