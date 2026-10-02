import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {startConfiguredPrinter,startClockedPrinter} from '../src/runtime/configured-printer.ts';
for(const reverse of [false,true])test(`unified printer startup owns configured hardware and print adapters (${reverse})`,async()=>{
 const f=await configuredPrinterFixture(reverse),controller=new AbortController();try{
  const pending=startConfiguredPrinter(f.reader,f.group,f.clocks,f.layout,f.options,controller.signal);
  (f.options.motion.position as number[])[0]=NaN;
  const printer=await pending;assert.equal(printer.hardware.status.state,'ready');assert.equal(printer.linear.kinematics.status.homedAxes,'');assert.equal(printer.print.gcode.usesPort(printer.linear.port),true);assert.equal(printer.hardware.heaters.status.available_heaters.length,2);assert.deepEqual(printer.linear.port.position(),[0,0,0,0]);assert.equal(f.firmware[0].motion.length,0);
  controller.abort(new Error('startup signal no longer owns lifetime'));assert.equal(printer.hardware.status.state,'ready');await printer.close();assert.equal(printer.hardware.status.state,'stopped');assert.equal(printer.linear.port.status.failed,true);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});
test('unified startup closes configured peers on invalid late homing coverage',async()=>{
 const f=await configuredPrinterFixture();try{
  f.options.linear.homing[0][0].emitters=['x'];await assert.rejects(startConfiguredPrinter(f.reader,f.group,f.clocks,f.layout,f.options,f.signal),/omits motors/);assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].motion.length,0);
 }finally{await f.close();}
});
test('unified startup cancellation during counter read cannot publish a printer',async()=>{
 const f=await configuredPrinterFixture(),controller=new AbortController();try{
  f.firmware[0].ignore('stepper_get_position');const pending=startConfiguredPrinter(f.reader,f.group,f.clocks,f.layout,f.options,controller.signal),rejected=assert.rejects(pending);await delay(20);controller.abort(new Error('cancel printer startup'));await rejected;assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].motion.length,0);
 }finally{await f.close();}
});
test('missing motion descriptors are rejected before MCU configuration',async()=>{
 const f=await configuredPrinterFixture();try{
  f.options.hardware.motion=undefined;await assert.rejects(startConfiguredPrinter(f.reader,f.group,f.clocks,f.layout,f.options,f.signal),/requires motion/);assert.deepEqual(f.stops,[0,0]);assert.equal(f.group.session('mcu').status.configured,false);
 }finally{await f.close();}
});
test('clocked startup derives every hardware mapping from connected sessions',async()=>{
 const f=await configuredPrinterFixture(true);try{
  const printer=await startClockedPrinter(f.reader,f.group,'mcu',f.layout,f.options,f.signal);
  assert.equal(printer.hardware.status.state,'ready');assert.equal(printer.linear.kinematics.status.homedAxes,'');assert.equal(f.firmware[0].motion.length,0);await printer.close();assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});
