import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {connectConfiguredPrinter} from '../src/runtime/configured-printer.ts';
for(const reverse of [false,true])test(`connector owner reaches configured printing and shuts down all peers (${reverse})`,async()=>{
 const f=await configuredPrinterFixture(reverse,false);let printer:Awaited<ReturnType<typeof connectConfiguredPrinter>>|undefined;
 try{
  const pending=connectConfiguredPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.signal);
  (f.options.motion.position as number[])[0]=NaN;
  printer=await pending;assert.equal(printer.group.status.state,'ready');assert.equal(printer.hardware.status.state,'ready');assert.equal(printer.linear.kinematics.status.homedAxes,'');assert.deepEqual(printer.linear.port.position(),[0,0,0,0]);
  assert.equal(f.firmware[0].motion.length,0);
  const aux=printer.hardware.plan.configurations.find(c=>c.mcu==='aux')!,sync=aux.synchronizer!;assert(sync);assert(sync.usesClocks(printer.group.session('mcu').clock.sync,printer.group.session('aux').clock.sync));assert.equal(printer.initial.generation.clockTimelines!.find(c=>c.id==='aux')!.synchronizer,sync);assert.equal(printer.hardware.plan.configurations.find(c=>c.mcu==='mcu')!.synchronizer,undefined);
  const g=printer.initial.generation,segments=aux.timeline.status.segments;assert.throws(()=>g.calibrateAuxiliaryClock('mcu'),/auxiliary MCU/);assert(g.calibrateAuxiliaryClock('aux'));assert.equal(aux.timeline.status.segments,segments+1);assert.deepEqual(aux.timeline.status.calibration,{offset:sync.mapping.offset,frequency:sync.mapping.frequency});
  await printer.linear.port.forcePosition([1,0,0,0],f.signal);assert.deepEqual(printer.linear.port.position(),[1,0,0,0]);assert.equal(aux.synchronizer,sync);
  assert.throws(()=>g.calibrateAuxiliaryClock('aux'),/active motion ownership/);
  await printer.close();assert.equal(printer.group.status.state,'stopped');assert.deepEqual(f.stops,[1,1]);
 }finally{await printer?.close();await f.close();}
});
test('connector owner cleans connected peers after configuration preflight fails',async()=>{
 const f=await configuredPrinterFixture(false,false);try{
  f.layout={...f.layout,heaters:[...f.layout.heaters,{section:'missing_heater'}]};
  await assert.rejects(connectConfiguredPrinter(f.reader,f.connections,'mcu',f.layout,f.options,f.signal));assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].motion.length,0);
 }finally{await f.close();}
});
test('connection cancellation waits for a late connector and closes both peers',async()=>{
 const f=await configuredPrinterFixture(false,false),controller=new AbortController(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const original=f.connections[1].connect;f.connections[1].connect=async(signal,stop)=>{const session=await original(signal,stop);entered.resolve();await release.promise;return session;};
 try{
  let settled=false;const pending=connectConfiguredPrinter(f.reader,f.connections,'mcu',f.layout,f.options,controller.signal).finally(()=>{settled=true;}),rejected=assert.rejects(pending);
  await entered.promise;controller.abort(new Error('cancel connected startup'));await Promise.resolve();assert.equal(settled,false);release.resolve();await rejected;assert.deepEqual(f.stops,[1,1]);assert.equal(f.firmware[0].motion.length,0);
 }finally{release.resolve();await f.close();}
});
test('unknown primary is rejected before any connector is acquired',async()=>{
 const f=await configuredPrinterFixture(false,false);try{await assert.rejects(connectConfiguredPrinter(f.reader,f.connections,'missing',f.layout,f.options,f.signal),/Primary/);assert.deepEqual(f.stops,[0,0]);}finally{await f.close();}
});
